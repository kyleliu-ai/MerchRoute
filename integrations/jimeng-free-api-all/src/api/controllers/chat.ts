import _ from "lodash";
import { PassThrough } from "stream";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { generateImages, DEFAULT_MODEL } from "./images.ts";
import { generateVideo, generateSeedanceVideo, isSeedanceModel, DEFAULT_MODEL as DEFAULT_VIDEO_MODEL } from "./videos.ts";

// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;

/**
 * 解析模型
 *
 * @param model 模型名称
 * @returns 模型信息
 */
function parseModel(model: string) {
  const [_model, size] = model.split(":");
  const [_, width, height] = /(\d+)[\W\w](\d+)/.exec(size) ?? [];
  return {
    model: _model,
    width: size ? Math.ceil(parseInt(width) / 2) * 2 : 1024,
    height: size ? Math.ceil(parseInt(height) / 2) * 2 : 1024,
  };
}

/**
 * 检测是否为视频生成请求
 *
 * @param model 模型名称
 * @returns 是否为视频生成请求
 */
function isVideoModel(model: string) {
  return model.startsWith("jimeng-video") || model.startsWith("seedance-");
}

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletion(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    if (messages.length === 0)
      throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "消息不能为空");

    const { model, width, height } = parseModel(_model);
    logger.info(messages);

    // 检查是否为视频生成请求
    if (isVideoModel(_model)) {
      try {
        // 视频生成
        logger.info(`开始生成视频，模型: ${_model}`);

        let videoUrl: string;

        // 判断是否为 Seedance 模型
        if (isSeedanceModel(_model)) {
          // Seedance 模型需要图片，在 chat 模式下不支持图片上传
          // 返回友好提示
          return {
            id: util.uuid(),
            model: _model,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: `Seedance 2.0 是多图智能视频生成模型，需要上传图片才能生成视频。\n\n请使用 POST /v1/videos/generations API 接口：\n\n\`\`\`bash\ncurl -X POST http://localhost:3000/v1/videos/generations \\\n  -H "Authorization: your_token" \\\n  -F "model=jimeng-video-seedance-2.0" \\\n  -F "prompt=@1 图片中的人物开始跳舞" \\\n  -F "ratio=4:3" \\\n  -F "duration=4" \\\n  -F "files=@/path/to/image1.jpg" \\\n  -F "files=@/path/to/image2.jpg"\n\`\`\`\n\n**参数说明：**\n- \`model\`: jimeng-video-seedance-2.0（推荐）、jimeng-video-seedance-2.0-fast（快速版）或 seedance-2.0（兼容）\n- \`prompt\`: 提示词，使用 @1, @2 等引用上传的图片\n- \`ratio\`: 视频比例 (默认 4:3)\n- \`duration\`: 视频时长 4-15 秒 (默认 4 秒)\n- \`files\`: 上传的图片文件（支持多张）`,
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            created: util.unixTimestamp(),
          };
        }

        videoUrl = await generateVideo(
          _model,
          messages[messages.length - 1].content,
          {
            ratio: "16:9",
            resolution: "720p", // 默认分辨率
          },
          refreshToken
        );

        logger.info(`视频生成成功，URL: ${videoUrl}`);
        return {
          id: util.uuid(),
          model: _model,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `![video](${videoUrl})\n`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        };
      } catch (error) {
        logger.error(`视频生成失败: ${error.message}`);
        // 如果是积分不足等特定错误，直接抛出
        if (error instanceof APIException) {
          throw error;
        }

        // 其他错误返回友好提示
        return {
          id: util.uuid(),
          model: _model,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `生成视频失败: ${error.message}\n\n如果您在即梦官网看到已生成的视频，可能是获取结果时出现了问题，请前往即梦官网查看。`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        };
      }
    } else {
      // 图像生成
      const imageUrls = await generateImages(
        model,
        messages[messages.length - 1].content,
        {
          width,
          height,
        },
        refreshToken
      );

      return {
        id: util.uuid(),
        model: _model || model,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: imageUrls.reduce(
                (acc, url, i) => acc + `![image_${i}](${url})\n`,
                ""
              ),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: util.unixTimestamp(),
      };
    }
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(messages, refreshToken, _model, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletionStream(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    const { model, width, height } = parseModel(_model);
    logger.info(messages);

    const stream = new PassThrough();

    if (messages.length === 0) {
      logger.warn("消息为空，返回空流");
      stream.end("data: [DONE]\n\n");
      return stream;
    }

    // 检查是否为视频生成请求
    if (isVideoModel(_model)) {
      // 视频生成
      stream.write(
        "data: " +
          JSON.stringify({
            id: util.uuid(),
            model: _model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "🎬 视频生成中，请稍候...\n这可能需要1-2分钟，请耐心等待" },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n"
      );

      // 视频生成
      logger.info(`开始生成视频，提示词: ${messages[messages.length - 1].content}`);

      // 进度更新定时器
      const progressInterval = setInterval(() => {
        stream.write(
          "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "." },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\n"
        );
      }, 5000);

      // 设置超时，防止无限等待
      const timeoutId = setTimeout(() => {
        clearInterval(progressInterval);
        logger.warn(`视频生成超时（2分钟），提示用户前往即梦官网查看`);
        stream.write(
          "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 1,
                  delta: {
                    role: "assistant",
                    content: "\n\n视频生成时间较长（已等待2分钟），但视频可能仍在生成中。\n\n请前往即梦官网查看您的视频：\n1. 访问 https://jimeng.jianying.com/ai-tool/video/generate\n2. 登录后查看您的创作历史\n3. 如果视频已生成，您可以直接在官网下载或分享\n\n您也可以继续等待，系统将在后台继续尝试获取视频（最长约20分钟）。",
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
        );
        // 注意：这里不结束流，让后台继续尝试获取视频
        // stream.end("data: [DONE]\n\n");
      }, 2 * 60 * 1000);

      logger.info(`开始生成视频，模型: ${_model}, 提示词: ${messages[messages.length - 1].content.substring(0, 50)}...`);

      // 先给用户一个初始提示
      stream.write(
        "data: " +
          JSON.stringify({
            id: util.uuid(),
            model: _model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "\n\n🎬 视频生成已开始，这可能需要几分钟时间...",
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n"
      );

      generateVideo(
        _model,
        messages[messages.length - 1].content,
        { ratio: "16:9", resolution: "720p" },
        refreshToken
      )
        .then((videoUrl) => {
          clearInterval(progressInterval);
          clearTimeout(timeoutId);

          logger.info(`视频生成成功，URL: ${videoUrl}`);

          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 1,
                    delta: {
                      role: "assistant",
                      content: `\n\n✅ 视频生成完成！\n\n![video](${videoUrl})\n\n您可以：\n1. 直接查看上方视频\n2. 使用以下链接下载或分享：${videoUrl}`,
                    },
                    finish_reason: null,
                  },
                ],
              }) +
              "\n\n"
          );

          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 2,
                    delta: {
                      role: "assistant",
                      content: "",
                    },
                    finish_reason: "stop",
                  },
                ],
              }) +
              "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        })
        .catch((err) => {
          clearInterval(progressInterval);
          clearTimeout(timeoutId);

          logger.error(`视频生成失败: ${err.message}`);
          logger.error(`错误详情: ${JSON.stringify(err)}`);

          // 记录详细错误信息
          logger.error(`视频生成失败: ${err.message}`);
          logger.error(`错误详情: ${JSON.stringify(err)}`);

          // 构建更详细的错误信息
          let errorMessage = `⚠️ 视频生成过程中遇到问题: ${err.message}`;

          // 如果是历史记录不存在的错误，提供更具体的建议
          if (err.message.includes("历史记录不存在")) {
            errorMessage += "\n\n可能原因：\n1. 视频生成请求已发送，但API无法获取历史记录\n2. 视频生成服务暂时不可用\n3. 历史记录ID无效或已过期\n\n建议操作：\n1. 请前往即梦官网查看您的视频是否已生成：https://jimeng.jianying.com/ai-tool/video/generate\n2. 如果官网已显示视频，但这里无法获取，可能是API连接问题\n3. 如果官网也没有显示，请稍后再试或重新生成视频";
          } else if (err.message.includes("获取视频生成结果超时")) {
            errorMessage += "\n\n视频生成可能仍在进行中，但等待时间已超过系统设定的限制。\n\n请前往即梦官网查看您的视频：https://jimeng.jianying.com/ai-tool/video/generate\n\n如果您在官网上看到视频已生成，但这里无法显示，可能是因为：\n1. 获取结果的过程超时\n2. 网络连接问题\n3. API访问限制";
          } else {
            errorMessage += "\n\n如果您在即梦官网看到已生成的视频，可能是获取结果时出现了问题。\n\n请访问即梦官网查看您的创作历史：https://jimeng.jianying.com/ai-tool/video/generate";
          }

          // 添加历史ID信息，方便用户在官网查找
          if (err.historyId) {
            errorMessage += `\n\n历史记录ID: ${err.historyId}（您可以使用此ID在官网搜索您的视频）`;
          }

          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 1,
                    delta: {
                      role: "assistant",
                      content: `\n\n${errorMessage}`,
                    },
                    finish_reason: "stop",
                  },
                ],
              }) +
              "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        });
    } else {
      // 图像生成
      stream.write(
        "data: " +
          JSON.stringify({
            id: util.uuid(),
            model: _model || model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "🎨 图像生成中，请稍候..." },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n"
      );

      generateImages(
        model,
        messages[messages.length - 1].content,
        { width, height },
        refreshToken
      )
        .then((imageUrls) => {
          for (let i = 0; i < imageUrls.length; i++) {
            const url = imageUrls[i];
            stream.write(
              "data: " +
                JSON.stringify({
                  id: util.uuid(),
                  model: _model || model,
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      index: i + 1,
                      delta: {
                        role: "assistant",
                        content: `![image_${i}](${url})\n`,
                      },
                      finish_reason: i < imageUrls.length - 1 ? null : "stop",
                    },
                  ],
                }) +
                "\n\n"
            );
          }
          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model || model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: imageUrls.length + 1,
                    delta: {
                      role: "assistant",
                      content: "图像生成完成！",
                    },
                    finish_reason: "stop",
                  },
                ],
              }) +
              "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        })
        .catch((err) => {
          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model || model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 1,
                    delta: {
                      role: "assistant",
                      content: `生成图片失败: ${err.message}`,
                    },
                    finish_reason: "stop",
                  },
                ],
              }) +
              "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        });
    }
    return stream;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          messages,
          refreshToken,
          _model,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

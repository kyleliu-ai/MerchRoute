import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "jimeng",
                        "object": "model",
                        "owned_by": "jimeng-free-api"
                    },
                    {
                        "id": "jimeng-5.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 5.0 版本（最新）"
                    },
                    {
                        "id": "jimeng-4.6",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 4.6 版本（最新）"
                    },
                    {
                        "id": "jimeng-4.5",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 4.5 版本"
                    },
                    {
                        "id": "jimeng-4.1",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 4.1 版本"
                    },
                    {
                        "id": "jimeng-4.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 4.0 版本"
                    },
                    {
                        "id": "jimeng-3.1",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 3.1 版本"
                    },
                    {
                        "id": "jimeng-3.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 3.0 版本"
                    },
                    {
                        "id": "jimeng-2.1",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 2.1 版本"
                    },
                    {
                        "id": "jimeng-2.0-pro",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 2.0 专业版"
                    },
                    {
                        "id": "jimeng-2.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 2.0 版本"
                    },
                    {
                        "id": "jimeng-1.4",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 1.4 版本"
                    },
                    {
                        "id": "jimeng-xl-pro",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI图像生成模型 XL Pro 版本"
                    },
                    {
                        "id": "jimeng-video-3.5-pro",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI视频生成模型 3.5 专业版"
                    },
                    {
                        "id": "jimeng-video-3.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI视频生成模型 3.0 版本"
                    },
                    {
                        "id": "jimeng-video-3.0-pro",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "即梦AI视频生成模型 3.0 专业版"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 多图智能视频生成模型（国内兼容接口可用；国际 token hk-/jp-/sg- 建议走 /v1/videos/international/generations）"
                    },
                    {
                        "id": "seedance-2.0",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 多图智能视频生成模型（jimeng-video-seedance-2.0 的别名，向后兼容）"
                    },
                    {
                        "id": "seedance-2.0-pro",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 Pro 多图智能视频生成模型（jimeng-video-seedance-2.0 的别名，向后兼容）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0-fast 快速多图智能视频生成模型（国内兼容接口可用；国际 token hk-/jp-/sg- 建议走 /v1/videos/international/generations）"
                    },
                    {
                        "id": "seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0-fast 快速多图智能视频生成模型（jimeng-video-seedance-2.0-fast 的别名，向后兼容）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-fast-vip",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 Fast VIP Vision 文生视频模型（dreamina_seedance_40_vision，VIP 快速版，支持文生视频和图生视频）"
                    },
                    {
                        "id": "seedance-2.0-fast-vip",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 Fast VIP Vision 文生视频模型（jimeng-video-seedance-2.0-fast-vip 的别名，向后兼容）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-vip",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 VIP Vision 主模态能力视频模型（dreamina_seedance_40_pro_vision，VIP 专业版，主模态能力）"
                    },
                    {
                        "id": "seedance-2.0-vip",
                        "object": "model",
                        "owned_by": "jimeng-free-api",
                        "description": "Seedance 2.0 VIP Vision 主模态能力视频模型（jimeng-video-seedance-2.0-vip 的别名，向后兼容）"
                    }
                ]
            };
        }

    }
}

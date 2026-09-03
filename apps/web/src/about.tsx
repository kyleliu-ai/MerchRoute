import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  ArrowRightOutlined,
  BellOutlined,
  BranchesOutlined,
  CalculatorOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CloudServerOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  GithubOutlined,
  GlobalOutlined,
  KeyOutlined,
  LinkOutlined,
  LockOutlined,
  PictureOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
  ToolOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { Alert, Button, Drawer, Input, Popconfirm, Skeleton, Tooltip, message } from 'antd';
import dayjs from 'dayjs';
import {
  api,
  type AboutContentScope,
  type AboutGithubAccessState,
  type AboutGithubAccessStatus,
  type AboutRuntimeStatus,
  type AboutSyncStatus,
  type AboutVersionInfo
} from './api/client';
import './about.css';

const REPOSITORY_URL = 'https://github.com/kyleliu-ai/MerchRoute';
const TOKEN_MANAGEMENT_URL = 'https://github.com/settings/personal-access-tokens';
const TOKEN_CREATION_URL = 'https://github.com/settings/personal-access-tokens/new?name=MerchRoute-About-ReadOnly&description=Read-only+content+verification+for+MerchRoute&target_name=kyleliu-ai&expires_in=90&contents=read';

const ROUTE_STAGES: Array<{ label: string; detail: string; icon: ReactNode }> = [
  { label: '采购与素材', detail: '建立商品与原始素材入口', icon: <DatabaseOutlined /> },
  { label: '主图与视频', detail: 'AI 生成可上架媒体', icon: <PictureOutlined /> },
  { label: '审核与投递', detail: '人工把关并保持顺序', icon: <SafetyCertificateOutlined /> },
  { label: '售价与运费', detail: '统一计算跨境成本', icon: <CalculatorOutlined /> },
  { label: 'WB / OZON 上品', detail: '资料、媒体与任务落地', icon: <ShopOutlined /> }
];

const CAPABILITIES: Array<{ title: string; description: string; code: string; icon: ReactNode }> = [
  { title: '采购与商品台账', description: '集中管理 SKU、采购摘要、素材来源与下载任务。', code: 'SOURCE', icon: <DatabaseOutlined /> },
  { title: 'AI 主图、套图与视频', description: '连接多个生成工作流，让商品素材连续流转。', code: 'CREATE', icon: <PictureOutlined /> },
  { title: '媒体审核与顺序', description: '保留人工选择、草稿、投递顺序与审核记录。', code: 'REVIEW', icon: <SafetyCertificateOutlined /> },
  { title: 'WB / OZON 自动上品', description: '围绕平台目录、资料、任务和异常状态组织上品。', code: 'LISTING', icon: <ShopOutlined /> },
  { title: '售价与跨境运费', description: '复用定价、运费模板，形成可解释的售价结果。', code: 'PRICING', icon: <CalculatorOutlined /> },
  { title: '任务消息与异常追踪', description: '让失败、等待与需人工处理的事项清晰可见。', code: 'TRACE', icon: <BellOutlined /> }
];

const POSITIONING = [
  { label: '本地优先・数据可控', icon: <CloudServerOutlined /> },
  { label: '可审核・可追踪', icon: <SafetyCertificateOutlined /> },
  { label: 'Windows + macOS', icon: <GlobalOutlined /> },
  { label: '开源 MIT', icon: <CodeOutlined /> }
];

const SYNC_STATUS_META: Record<AboutSyncStatus, { label: string; detail: string; icon: ReactNode }> = {
  SYNCED: {
    label: '运行与部署内容已同步',
    detail: '本机源码、n8n/部署资产和 GitHub 目标内容一致，无需再次同步。',
    icon: <CheckCircleOutlined />
  },
  LOCAL_ONLY: {
    label: '本机存在尚未发布的内容',
    detail: '本机存在尚未发布的运行或部署内容，建议按“本机 → GitHub”流程创建 Draft PR。',
    icon: <CloudUploadOutlined />
  },
  REMOTE_ONLY: {
    label: 'GitHub 存在本机未包含的内容',
    detail: 'GitHub 存在本机未包含的运行或部署内容，仅允许查看差异，不自动更新本机。',
    icon: <CloudDownloadOutlined />
  },
  DIVERGED: {
    label: '运行与部署内容存在双向差异',
    detail: '运行或部署内容存在双向差异，应保留本机内容并人工审查。',
    icon: <BranchesOutlined />
  },
  UNAVAILABLE: {
    label: '暂时无法完整核验',
    detail: '暂时无法完整核验版本内容，不影响当前服务运行。',
    icon: <WarningOutlined />
  }
};

const RUNTIME_STATUS_META: Record<AboutRuntimeStatus, { label: string; icon: ReactNode }> = {
  CURRENT: { label: '当前运行构建已包含本机源码', icon: <CheckCircleOutlined /> },
  REBUILD_REQUIRED: { label: '本机源码已变化，当前服务需要重新构建并重启', icon: <ToolOutlined /> },
  UNKNOWN: { label: '暂时无法确认运行构建与本机源码的关系', icon: <QuestionCircleOutlined /> }
};

const CONTENT_SCOPE_META: Record<AboutContentScope, { label: string; icon: ReactNode }> = {
  runtime: { label: '运行与部署', icon: <ToolOutlined /> },
  documentation: { label: '文档', icon: <FileTextOutlined /> },
  verification: { label: '测试与 CI', icon: <SafetyCertificateOutlined /> }
};

export function AboutPage() {
  const queryClient = useQueryClient();
  const [accessDrawerOpen, setAccessDrawerOpen] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const versionQuery = useQuery({
    queryKey: ['about-version'],
    queryFn: () => api.aboutVersion(false),
    retry: false,
    staleTime: 10 * 60_000
  });
  const accessQuery = useQuery({
    queryKey: ['about-github-access'],
    queryFn: () => api.aboutGithubAccess(),
    retry: false
  });
  const refreshMutation = useMutation({
    mutationFn: () => api.aboutVersion(true),
    onSuccess: async (data) => {
      queryClient.setQueryData(['about-version'], data);
      await accessQuery.refetch();
    }
  });
  const saveAccessMutation = useMutation({
    mutationFn: () => api.saveAboutGithubAccess(accessToken.trim()),
    onSuccess: async (data) => {
      setAccessToken('');
      queryClient.setQueryData(['about-github-access'], data);
      message.success('Access Token 已验证并安全保存');
      const version = await api.aboutVersion(true);
      queryClient.setQueryData(['about-version'], version);
      await accessQuery.refetch();
    }
  });
  const anonymousMutation = useMutation({
    mutationFn: () => api.useAnonymousGithubAccess(),
    onSuccess: async (data) => {
      setAccessToken('');
      queryClient.setQueryData(['about-github-access'], data);
      message.success('已切换为 GitHub 匿名请求');
      const version = await api.aboutVersion(true);
      queryClient.setQueryData(['about-version'], version);
      await accessQuery.refetch();
    }
  });
  useEffect(() => {
    if (versionQuery.dataUpdatedAt) void accessQuery.refetch();
  }, [versionQuery.dataUpdatedAt]);
  const version = versionQuery.data;
  const repositoryUrl = version?.repositoryUrl || REPOSITORY_URL;
  const compareUrl = version?.available?.compareUrl;

  return (
    <main className="about-page">
      <section className="about-hero" aria-labelledby="about-title">
        <div className="about-hero-glow" aria-hidden="true" />
        <div className="about-hero-copy">
          <div className="about-brand-signature">
            <span className="about-logo"><img src="/brand-logo.png" alt="MerchRoute" /></span>
            <span>
              <strong>MerchRoute</strong>
              <small>AI MARKETPLACE OPERATIONS PLATFORM</small>
            </span>
          </div>
          <p className="about-kicker">FROM SOURCE TO SHELF.</p>
          <h1 id="about-title">铺货运营，从素材到上架一次跑通</h1>
          <p className="about-lead">MerchRoute 帮你把采购商品、AI 主图视频、人工审核、定价运费与 WB / OZON 上品连成一条可追踪的自动化链路。</p>
          <div className="about-hero-tags" aria-label="产品特征">
            <span>LOCAL FIRST</span><span>HUMAN IN THE LOOP</span><span>OPEN SOURCE</span>
          </div>
        </div>
        <VersionPanel
          query={versionQuery}
          refreshing={versionQuery.isFetching || refreshMutation.isPending}
          refreshError={refreshMutation.error}
          onRefresh={() => refreshMutation.mutate()}
          access={accessQuery.data?.access}
          onConfigureAccess={() => setAccessDrawerOpen(true)}
        />
      </section>

      <GithubAccessDrawer
        open={accessDrawerOpen}
        access={accessQuery.data?.access}
        loading={accessQuery.isLoading}
        loadError={accessQuery.error}
        token={accessToken}
        saving={saveAccessMutation.isPending}
        disabling={anonymousMutation.isPending}
        saveError={saveAccessMutation.error}
        onTokenChange={setAccessToken}
        onSave={() => saveAccessMutation.mutate()}
        onUseAnonymous={() => anonymousMutation.mutate()}
        onClose={() => {
          if (saveAccessMutation.isPending || anonymousMutation.isPending) return;
          setAccessToken('');
          saveAccessMutation.reset();
          anonymousMutation.reset();
          setAccessDrawerOpen(false);
        }}
      />

      <section className="about-section about-route-section" aria-labelledby="about-route-title">
        <SectionHeading eyebrow="OPERATIONS ROUTE" title="一条链路，串起商品运营全流程" id="about-route-title" description="每一步都保留清晰入口、状态和交接关系。" />
        <ol className="about-route">
          {ROUTE_STAGES.map((stage, index) => (
            <li key={stage.label}>
              <span className="about-route-index">0{index + 1}</span>
              <span className="about-route-icon" aria-hidden="true">{stage.icon}</span>
              <strong>{stage.label}</strong>
              <small>{stage.detail}</small>
              {index < ROUTE_STAGES.length - 1 && <ArrowRightOutlined className="about-route-arrow" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </section>

      <section className="about-section" aria-labelledby="about-capability-title">
        <SectionHeading eyebrow="CORE CAPABILITIES" title="六大能力，围绕真实业务协同" id="about-capability-title" description="不替代运营判断，把重复工作、媒体流转和状态追踪组织得更可靠。" />
        <div className="about-capability-grid">
          {CAPABILITIES.map((capability) => (
            <article className="about-capability" key={capability.title}>
              <div className="about-capability-top">
                <span className="about-capability-icon" aria-hidden="true">{capability.icon}</span>
                <span className="about-capability-code">{capability.code}</span>
              </div>
              <h3>{capability.title}</h3>
              <p>{capability.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="about-section about-positioning-section" aria-labelledby="about-positioning-title">
        <SectionHeading eyebrow="PRODUCT PRINCIPLES" title="面向本地自动化的产品定位" id="about-positioning-title" />
        <div className="about-positioning-grid">
          {POSITIONING.map((item) => <div className="about-positioning-item" key={item.label}><span aria-hidden="true">{item.icon}</span><strong>{item.label}</strong></div>)}
        </div>
      </section>

      <section className="about-github" aria-labelledby="about-github-title">
        <div>
          <span className="about-github-icon" aria-hidden="true"><GithubOutlined /></span>
          <div>
            <p className="about-section-eyebrow">SOURCE &amp; HISTORY</p>
            <h2 id="about-github-title">在 GitHub 查看源码与提交历史</h2>
            <p>此页面只读取公开内容与提交信息，不会自动更新、拉取或替换本地代码。</p>
          </div>
        </div>
        <div className="about-github-actions">
          <Button href={repositoryUrl} target="_blank" rel="noopener noreferrer" icon={<GithubOutlined />}>打开 GitHub 仓库</Button>
          {compareUrl
            ? <Button type="primary" href={compareUrl} target="_blank" rel="noopener noreferrer" icon={<LinkOutlined />}>查看提交历史</Button>
            : <Tooltip title="当前没有可用的 Compare 链接"><Button type="primary" disabled icon={<LinkOutlined />}>查看提交历史</Button></Tooltip>}
        </div>
      </section>
    </main>
  );
}

function VersionPanel({
  query,
  refreshing,
  refreshError,
  onRefresh,
  access,
  onConfigureAccess
}: {
  query: UseQueryResult<AboutVersionInfo, Error>;
  refreshing: boolean;
  refreshError: Error | null;
  onRefresh: () => void;
  access?: AboutGithubAccessStatus;
  onConfigureAccess: () => void;
}) {
  if (query.isLoading) {
    return <aside className="about-version-panel" aria-label="版本信息"><VersionHeading access={access} refreshing={refreshing} onRefresh={onRefresh} onConfigureAccess={onConfigureAccess} /><Skeleton active title={{ width: '48%' }} paragraph={{ rows: 7 }} /></aside>;
  }

  const version = query.data;
  if (!version) {
    return (
      <aside className="about-version-panel" aria-label="版本信息">
        <VersionHeading access={access} refreshing={refreshing} onRefresh={onRefresh} onConfigureAccess={onConfigureAccess} />
        <div className="about-version-empty"><WarningOutlined /><strong>版本信息加载失败</strong><span>{refreshError?.message || query.error?.message || '请稍后重新检查'}</span></div>
      </aside>
    );
  }

  const syncMeta = SYNC_STATUS_META[version.syncStatus];
  const runtimeMeta = RUNTIME_STATUS_META[version.runtimeStatus];
  return (
    <aside className="about-version-panel" aria-label="版本信息">
      <VersionHeading access={access} scopeVersion={version.scopeVersion} refreshing={refreshing} onRefresh={onRefresh} onConfigureAccess={onConfigureAccess} />
      <div className={`about-version-status is-${version.syncStatus.toLowerCase()}`} aria-live="polite">
        <span className="about-version-status-icon" aria-hidden="true">{syncMeta.icon}</span>
        <span><strong>{syncMeta.label}</strong><small>{syncMeta.detail}</small></span>
      </div>
      <div className={`about-runtime-status is-${version.runtimeStatus.toLowerCase()}`}>
        <span aria-hidden="true">{runtimeMeta.icon}</span><strong>{runtimeMeta.label}</strong>
      </div>
      <div className="about-version-builds">
        <VersionBuild label={version.current.buildChannel === 'candidate' ? '当前运行构建（候选）' : '当前运行构建'} primary={version.current.releaseTag || version.current.productVersion} secondary={shortSha(version.current.commitSha)} />
        <VersionBuild label={version.available?.source === 'release' ? 'GitHub Release' : 'GitHub main'} primary={version.available?.label || '暂不可用'} secondary={shortSha(version.available?.commitSha)} />
      </div>
      <div className="about-content-comparison" aria-label="内容范围核验结果">
        {(Object.keys(CONTENT_SCOPE_META) as AboutContentScope[]).map((scope) => (
          <ContentComparisonRow key={scope} scope={scope} comparison={version.contentComparison[scope]} />
        ))}
      </div>
      <div className="about-version-diagnostics">
        <p>{historyDescription(version)}</p>
        <p>{auxiliaryContentDescription(version)}</p>
      </div>
      <dl className="about-version-details">
        <div><dt>配置契约版本</dt><dd>{version.current.configVersion}</dd></div>
        <div><dt>指纹范围契约</dt><dd>schema v{version.scopeVersion || '—'}</dd></div>
        <div><dt>构建时间</dt><dd>{version.current.builtAt ? dayjs(version.current.builtAt).format('YYYY-MM-DD HH:mm') : '—'}</dd></div>
        <div><dt>构建状态</dt><dd>{version.current.dirty === undefined ? '—' : version.current.dirty ? '包含未提交修改' : '干净构建'}</dd></div>
        <div><dt>{version.available?.source === 'release' ? 'GitHub 发布日期' : 'GitHub 提交日期'}</dt><dd>{version.available?.publishedAt ? dayjs(version.available.publishedAt).format('YYYY-MM-DD HH:mm') : '—'}</dd></div>
        <div><dt>核验时间</dt><dd>{dayjs(version.checkedAt).format('YYYY-MM-DD HH:mm')}</dd></div>
      </dl>
      {(version.error || refreshError) && <p className="about-version-error">{version.error || refreshError?.message}</p>}
    </aside>
  );
}

function VersionHeading({ access, scopeVersion, refreshing, onRefresh, onConfigureAccess }: {
  access?: AboutGithubAccessStatus;
  scopeVersion?: number;
  refreshing: boolean;
  onRefresh: () => void;
  onConfigureAccess: () => void;
}) {
  const accessTone = githubAccessTone(access);
  const accessLabel = githubAccessButtonLabel(access);
  return (
    <div className="about-version-heading">
      <div><p className="about-version-eyebrow">CONTENT SYNC{scopeVersion ? ` · SCOPE V${scopeVersion}` : ''}</p><h2>内容同步状态</h2></div>
      <div className="about-version-heading-actions">
        <Tooltip title={accessLabel}>
          <Button className="about-access-trigger" aria-label="配置 Access Token" type="text" icon={<KeyOutlined />} onClick={onConfigureAccess}>
            <span className={`about-access-dot is-${accessTone}`} aria-hidden="true" />
            <span>配置 Access Token</span>
          </Button>
        </Tooltip>
        <Tooltip title="重新核验内容"><Button aria-label="重新检查版本" type="text" loading={refreshing} icon={<ReloadOutlined />} onClick={onRefresh} /></Tooltip>
      </div>
    </div>
  );
}

function GithubAccessDrawer({
  open,
  access,
  loading,
  loadError,
  token,
  saving,
  disabling,
  saveError,
  onTokenChange,
  onSave,
  onUseAnonymous,
  onClose
}: {
  open: boolean;
  access?: AboutGithubAccessStatus;
  loading: boolean;
  loadError: Error | null;
  token: string;
  saving: boolean;
  disabling: boolean;
  saveError: Error | null;
  onTokenChange: (value: string) => void;
  onSave: () => void;
  onUseAnonymous: () => void;
  onClose: () => void;
}) {
  const meta = githubAccessDrawerMeta(access);
  const tokenReady = /^github_pat_[A-Za-z0-9_]{20,400}$/.test(token.trim());
  const busy = saving || disabling;
  const canManage = access?.canManage !== false;
  return (
    <Drawer
      className="about-access-drawer"
      width="min(520px, 100vw)"
      open={open}
      destroyOnHidden
      title={<span className="about-access-drawer-title"><KeyOutlined /><strong>GitHub 只读 Access Token</strong></span>}
      onClose={onClose}
    >
      {loading ? <Skeleton active paragraph={{ rows: 8 }} /> : (
        <div className="about-access-drawer-body">
          <section className={`about-access-state is-${meta.tone}`} aria-live="polite">
            <span className="about-access-state-icon" aria-hidden="true">{meta.icon}</span>
            <div>
              <p>当前请求方式</p>
              <h3>{meta.title}</h3>
              <span>{meta.description}</span>
            </div>
          </section>

          {loadError && <Alert showIcon type="warning" message="Access Token 状态暂时无法读取" description={loadError.message} />}
          {!canManage && <Alert showIcon type="warning" message="当前页面不是从本机打开" description="Access Token 只允许在运行 MerchRoute 的电脑上配置。远程访问仍可查看同步状态。" />}
          {access?.anonymousFallback && <Alert showIcon type="warning" message="已自动回退匿名请求" description="当前 Token 已失效、权限不足或额度受限；内容核验仍会继续，但请尽快生成并保存新 Token。" />}

          <dl className="about-access-facts">
            <div><dt>配置来源</dt><dd>{githubAccessSourceLabel(access)}</dd></div>
            <div><dt>最近核验</dt><dd>{access?.checkedAt ? dayjs(access.checkedAt).format('YYYY-MM-DD HH:mm') : '尚未核验'}</dd></div>
            <div><dt>GitHub 额度</dt><dd>{access?.rateLimit ? `${access.rateLimit.remaining} / ${access.rateLimit.limit}` : '等待 GitHub 响应'}</dd></div>
            <div><dt>额度重置</dt><dd>{access?.rateLimit?.resetAt ? dayjs(access.rateLimit.resetAt).format('MM-DD HH:mm') : '—'}</dd></div>
          </dl>

          <section className="about-access-lifecycle" aria-labelledby="about-access-lifecycle-title">
            <div className="about-access-section-heading">
              <p>90-DAY ROTATION</p>
              <h3 id="about-access-lifecycle-title">生成、验证、到期更换</h3>
            </div>
            <div className="about-access-rail" aria-label="Access Token 配置流程">
              <span><i>01</i><strong>生成</strong><small>仅选 MerchRoute</small></span>
              <span><i>02</i><strong>验证并保存</strong><small>确认只读访问</small></span>
              <span><i>03</i><strong>到期更换</strong><small>重新生成并替换</small></span>
            </div>
          </section>

          <section className="about-access-guide" aria-labelledby="about-access-guide-title">
            <div className="about-access-section-heading">
              <p>GITHUB SETUP</p>
              <h3 id="about-access-guide-title">生成细粒度只读 Token</h3>
            </div>
            <ol>
              <li><span>1</span><p>点击下方按钮，GitHub 会预填名称、资源所有者、90 天期限和 <code>Contents: read</code>。</p></li>
              <li><span>2</span><p>在 Repository access 中选择 <code>Only select repositories</code>，只勾选 <code>MerchRoute</code>。</p></li>
              <li><span>3</span><p>确认 Repository permissions 只有 <code>Contents: Read-only</code>；Metadata 只读由 GitHub 自动附加。</p></li>
              <li><span>4</span><p>生成后立即复制一次，返回这里粘贴并验证。到期日以 GitHub 管理页为准。</p></li>
            </ol>
            <div className="about-access-external-actions">
              <Button type="primary" href={TOKEN_CREATION_URL} target="_blank" rel="noopener noreferrer" icon={<GithubOutlined />}>生成 90 天只读 Token</Button>
              <Button href={TOKEN_MANAGEMENT_URL} target="_blank" rel="noopener noreferrer" icon={<LinkOutlined />}>管理 GitHub Tokens</Button>
            </div>
          </section>

          <section className="about-access-form" aria-labelledby="about-access-form-title">
            <div className="about-access-section-heading">
              <p>SECURE STORAGE</p>
              <h3 id="about-access-form-title">粘贴并验证</h3>
            </div>
            <Alert showIcon type="info" icon={<LockOutlined />} message="Token 只写且不会再次显示" description="MerchRoute 验证仓库只读权限后加密保存在本机应用数据目录；不会写入浏览器、仓库、n8n 或普通日志。" />
            <label htmlFor="about-github-token">Fine-grained Access Token</label>
            <Input.Password
              id="about-github-token"
              aria-label="GitHub fine-grained Access Token"
              autoComplete="new-password"
              maxLength={512}
              value={token}
              status={token && !tokenReady ? 'error' : undefined}
              placeholder="粘贴以 github_pat_ 开头的完整 Token"
              onChange={(event) => onTokenChange(event.target.value)}
              onPressEnter={() => { if (tokenReady && canManage && !busy) onSave(); }}
            />
            {token && !tokenReady && <p className="about-access-input-error">请输入以 github_pat_ 开头的完整细粒度 Token。</p>}
            {saveError && <Alert showIcon type="error" message="Access Token 未保存" description={saveError.message} />}
            <div className="about-access-form-actions">
              <Button type="primary" icon={<SafetyCertificateOutlined />} loading={saving} disabled={!tokenReady || !canManage || disabling} onClick={onSave}>验证并保存</Button>
              <Popconfirm
                title="停用 Access Token？"
                description="MerchRoute 将立即改用 GitHub 匿名请求，旧环境变量也不会重新接管。"
                okText="停用并切换匿名模式"
                cancelText="取消"
                okButtonProps={{ danger: true, loading: disabling }}
                onConfirm={onUseAnonymous}
              >
                <Button danger type="text" disabled={!canManage || busy || (access?.mode === 'ANONYMOUS' && access.source === 'NONE')}>停用 Token，切换匿名模式</Button>
              </Popconfirm>
            </div>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function githubAccessTone(access: AboutGithubAccessStatus | undefined): 'verified' | 'anonymous' | 'warning' {
  if (!access || (access.mode === 'ANONYMOUS' && access.source === 'NONE' && !access.anonymousFallback)) return 'anonymous';
  if (access.mode === 'AUTHENTICATED' && access.state === 'VERIFIED') return 'verified';
  return 'warning';
}

function githubAccessButtonLabel(access: AboutGithubAccessStatus | undefined): string {
  const tone = githubAccessTone(access);
  return tone === 'verified' ? 'Access Token 已验证' : tone === 'warning' ? 'Access Token 需要检查或更换' : '当前使用 GitHub 匿名请求';
}

function githubAccessDrawerMeta(access: AboutGithubAccessStatus | undefined): { tone: 'verified' | 'anonymous' | 'warning'; title: string; description: string; icon: ReactNode } {
  const tone = githubAccessTone(access);
  if (tone === 'verified') return { tone, title: '专用只读 Token 已验证', description: '当前内容核验使用认证请求，并保留十分钟结果缓存。', icon: <CheckCircleOutlined /> };
  if (tone === 'warning') {
    const titleByState: Partial<Record<AboutGithubAccessState, string>> = {
      INVALID: 'Access Token 已失效',
      INSUFFICIENT_ACCESS: 'Access Token 权限不足',
      RATE_LIMITED: 'GitHub 额度暂时受限',
      UNAVAILABLE: 'Access Token 状态不可用'
    };
    return { tone, title: titleByState[access?.state || 'UNAVAILABLE'] || 'Access Token 等待核验', description: access?.anonymousFallback ? '当前已使用匿名请求继续核验，不影响本机服务运行。' : '请重新核验或配置新的只读 Token。', icon: <WarningOutlined /> };
  }
  return { tone, title: 'GitHub 匿名请求', description: '未配置 Token 时仍可正常核验公开仓库；匿名额度按当前公网 IP 计算。', icon: <GithubOutlined /> };
}

function githubAccessSourceLabel(access: AboutGithubAccessStatus | undefined): string {
  if (access?.source === 'MANAGED') return 'MerchRoute 本机加密托管';
  if (access?.source === 'ENVIRONMENT') return '运行环境变量（兼容模式）';
  return '未配置，使用匿名请求';
}

function ContentComparisonRow({ scope, comparison }: { scope: AboutContentScope; comparison: AboutVersionInfo['contentComparison'][AboutContentScope] }) {
  const meta = CONTENT_SCOPE_META[scope];
  const result = comparison.status === 'MATCH'
    ? '一致'
    : comparison.status === 'DIFFERENT'
      ? `差异 ${comparison.differenceCount ?? 0} 项`
      : '无法核验';
  return (
    <div className={`about-content-row is-${comparison.status.toLowerCase()}`}>
      <span><i aria-hidden="true">{meta.icon}</i>{meta.label}</span><strong>{result}</strong>
    </div>
  );
}

function VersionBuild({ label, primary, secondary }: { label: string; primary: string; secondary: string }) {
  return <div className="about-version-build"><span>{label}</span><strong>{primary}</strong><code>{secondary}</code></div>;
}

function SectionHeading({ eyebrow, title, id, description }: { eyebrow: string; title: string; id: string; description?: string }) {
  return <header className="about-section-heading"><div><p className="about-section-eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div>{description && <p>{description}</p>}</header>;
}

function historyDescription(version: AboutVersionInfo): string {
  const history = version.historyComparison;
  if (history.status === 'IDENTICAL') return '提交历史一致。';
  if (history.status === 'UNKNOWN') return '提交历史暂时无法核验；内容指纹仍作为主判断依据。';
  const localOnly = history.localOnlyCommits ?? 0;
  const remoteOnly = history.remoteOnlyCommits ?? 0;
  const suffix = version.syncStatus === 'SYNCED' ? '该差异不影响当前内容一致性。' : '提交历史仅用于诊断，不代替内容核验。';
  return `提交历史不同：本机独有 ${localOnly} 个提交，GitHub 独有 ${remoteOnly} 个提交。${suffix}`;
}

function auxiliaryContentDescription(version: AboutVersionInfo): string {
  const parts: string[] = [];
  const documentation = version.contentComparison.documentation;
  const verification = version.contentComparison.verification;
  if (documentation.status === 'DIFFERENT') parts.push(`文档 ${documentation.differenceCount ?? 0} 项`);
  if (verification.status === 'DIFFERENT') parts.push(`测试与 CI ${verification.differenceCount ?? 0} 项`);
  if (parts.length) return `仓库辅助内容存在差异：${parts.join('，')}。`;
  if (documentation.status === 'UNAVAILABLE' || verification.status === 'UNAVAILABLE') return '仓库辅助内容暂时无法完整核验。';
  return '文档、测试与 CI 内容一致。';
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

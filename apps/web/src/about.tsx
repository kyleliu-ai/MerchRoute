import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightOutlined,
  BellOutlined,
  BranchesOutlined,
  CalculatorOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DatabaseOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  PictureOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
  SyncOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { Button, Skeleton, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { api, type AboutVersionInfo, type AboutVersionStatus } from './api/client';
import './about.css';

const REPOSITORY_URL = 'https://github.com/kyleliu-ai/MerchRoute';

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

const STATUS_META: Record<AboutVersionStatus, { label: (version: AboutVersionInfo) => string; detail: (version: AboutVersionInfo) => string; icon: ReactNode }> = {
  UPDATE_AVAILABLE: { label: (version) => `可更新 ${version.aheadBy} 个提交`, detail: () => 'GitHub 目标版本包含当前构建之后的新内容', icon: <SyncOutlined /> },
  UP_TO_DATE: { label: () => '当前已是最新', detail: () => '当前构建与 GitHub 目标版本一致', icon: <CheckCircleOutlined /> },
  LOCAL_AHEAD: { label: () => '本地构建领先', detail: () => '当前构建包含 GitHub 目标版本之外的提交', icon: <BranchesOutlined /> },
  DIVERGED: { label: () => '版本分支已分叉', detail: (version) => `GitHub 目标另有 ${version.aheadBy} 个提交，建议先查看差异`, icon: <BranchesOutlined /> },
  UNAVAILABLE: { label: () => '暂时无法判断', detail: () => '产品版本仍可用，可稍后重新检查 GitHub', icon: <WarningOutlined /> }
};

export function AboutPage() {
  const versionQuery = useQuery({
    queryKey: ['about-version'],
    queryFn: api.aboutVersion,
    retry: false,
    staleTime: 10 * 60_000
  });
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
        <VersionPanel query={versionQuery} />
      </section>

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
            <p className="about-section-eyebrow">SOURCE &amp; RELEASES</p>
            <h2 id="about-github-title">在 GitHub 查看源码与版本差异</h2>
            <p>此页面只读取公开版本信息，不会自动更新、拉取或替换本地代码。</p>
          </div>
        </div>
        <div className="about-github-actions">
          <Button href={repositoryUrl} target="_blank" rel="noopener noreferrer" icon={<GithubOutlined />}>打开 GitHub 仓库</Button>
          {compareUrl
            ? <Button type="primary" href={compareUrl} target="_blank" rel="noopener noreferrer" icon={<LinkOutlined />}>查看版本差异</Button>
            : <Tooltip title="当前没有可用的 Compare 链接"><Button type="primary" disabled icon={<LinkOutlined />}>查看版本差异</Button></Tooltip>}
        </div>
      </section>
    </main>
  );
}

function VersionPanel({ query }: { query: ReturnType<typeof useQuery<AboutVersionInfo, Error>> }) {
  if (query.isLoading) {
    return <aside className="about-version-panel" aria-label="版本信息"><p className="about-version-eyebrow">VERSION CHECK</p><Skeleton active title={{ width: '48%' }} paragraph={{ rows: 5 }} /></aside>;
  }

  const version = query.data;
  if (!version) {
    return (
      <aside className="about-version-panel" aria-label="版本信息">
        <p className="about-version-eyebrow">VERSION CHECK</p>
        <div className="about-version-empty"><WarningOutlined /><strong>版本信息加载失败</strong><span>{query.error?.message || '请稍后重新检查'}</span></div>
        <Button className="about-version-retry" icon={<ReloadOutlined />} onClick={() => void query.refetch()}>重新检查</Button>
      </aside>
    );
  }

  const meta = STATUS_META[version.status];
  return (
    <aside className="about-version-panel" aria-label="版本信息">
      <div className="about-version-heading">
        <div><p className="about-version-eyebrow">VERSION CHECK</p><h2>版本状态</h2></div>
        <Tooltip title="重新检查版本"><Button aria-label="重新检查版本" type="text" icon={<ReloadOutlined spin={query.isFetching} />} onClick={() => void query.refetch()} /></Tooltip>
      </div>
      <div className={`about-version-status is-${version.status.toLowerCase()}`} aria-live="polite">
        <span className="about-version-status-icon" aria-hidden="true">{meta.icon}</span>
        <span><strong>{meta.label(version)}</strong><small>{meta.detail(version)}</small></span>
      </div>
      <div className="about-version-builds">
        <VersionBuild label="当前产品版本" primary={version.current.productVersion} secondary={shortSha(version.current.commitSha)} />
        <VersionBuild label={version.available?.source === 'release' ? 'GitHub Release' : 'GitHub main'} primary={version.available?.label || '暂不可用'} secondary={shortSha(version.available?.commitSha)} />
      </div>
      <dl className="about-version-details">
        <div><dt>配置契约版本</dt><dd>{version.current.configVersion}</dd></div>
        <div><dt>{version.available?.source === 'release' ? 'GitHub 发布日期' : 'GitHub 提交日期'}</dt><dd>{version.available?.publishedAt ? dayjs(version.available.publishedAt).format('YYYY-MM-DD HH:mm') : '—'}</dd></div>
        <div><dt>检查时间</dt><dd>{dayjs(version.checkedAt).format('YYYY-MM-DD HH:mm')}</dd></div>
      </dl>
      {version.error && <p className="about-version-error">{version.error}</p>}
    </aside>
  );
}

function VersionBuild({ label, primary, secondary }: { label: string; primary: string; secondary: string }) {
  return <div className="about-version-build"><span>{label}</span><strong>{primary}</strong><code>{secondary}</code></div>;
}

function SectionHeading({ eyebrow, title, id, description }: { eyebrow: string; title: string; id: string; description?: string }) {
  return <header className="about-section-heading"><div><p className="about-section-eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div>{description && <p>{description}</p>}</header>;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

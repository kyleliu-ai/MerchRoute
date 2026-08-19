import { ClockCircleOutlined, LinkOutlined, ReloadOutlined, ShopOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { WbStorePublication } from './api/client';
import { CopyValueButton } from './copy-value';
import { summarizeWbPublications, wbPublicationProductLinks, wbPublicationStatusMeta } from './wb-publication-results-utils';

const { Text } = Typography;

function publicationSourceLabel(source: string) {
  if (source === 'MANUAL') return '手动提交';
  if (source === 'AUTOMATION' || source === 'AUTO' || source === 'AUTO_PUBLISH') return '自动上品';
  return source || '未知来源';
}

export function WbPublicationResults({
  publications,
  loading,
  refreshing,
  error,
  onRefresh
}: {
  publications: WbStorePublication[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  onRefresh: () => void;
}) {
  const summary = summarizeWbPublications(publications);
  const ordered = [...publications].sort((left, right) => {
    const timeDifference = dayjs(right.updatedAt).valueOf() - dayjs(left.updatedAt).valueOf();
    return timeDifference || right.revision - left.revision;
  });

  return <Card
    className="wb-publication-results"
    title={<div className="wb-publication-results-title"><span><ShopOutlined /></span><div><small>STORE PUBLICATIONS</small><strong>店铺发布结果</strong></div></div>}
    extra={<Space size={7}><Tag color={summary.active ? 'processing' : summary.attention ? 'volcano' : summary.allSucceeded ? 'green' : 'default'}>{summary.total} 条店铺记录</Tag><Button aria-label="刷新店铺发布结果" size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>刷新</Button></Space>}
  >
    {loading ? <Skeleton active paragraph={{ rows: 3 }} /> : error ? <Alert
      showIcon
      type="error"
      message="店铺发布结果加载失败"
      description={error.message}
      action={<Button size="small" onClick={onRefresh}>重试</Button>}
    /> : !ordered.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未提交到任何 WB 店铺" /> : <>
      <div className="wb-publication-summary" aria-label="店铺发布汇总">
        <div><small>总店铺记录</small><strong>{summary.total}</strong></div>
        <div className="is-success"><small>已完成</small><strong>{summary.succeeded}</strong></div>
        <div className="is-active"><small>处理中</small><strong>{summary.active}</strong></div>
        <div className="is-attention"><small>需处理 / 暂停</small><strong>{summary.attention + summary.paused}</strong></div>
      </div>
      <div className="wb-publication-result-list">
        {ordered.map((publication) => {
          const status = wbPublicationStatusMeta[publication.status];
          const links = wbPublicationProductLinks(publication);
          const hasError = Boolean(publication.errorCode || publication.errorMessage);
          return <article className={`wb-publication-result is-${publication.status.toLowerCase().replace('_', '-')}`} aria-label={`${publication.storeDisplayName || publication.storeAlias} 发布结果`} key={publication.id}>
            <header className="wb-publication-result-head">
              <span className="wb-publication-result-mark" aria-hidden="true" />
              <div><strong>{publication.storeDisplayName || publication.storeAlias}</strong><code>{publication.storeAlias} · R{publication.revision}</code></div>
              <Tag color={status.color}>{status.label}</Tag>
            </header>
            <div className="wb-publication-result-facts">
              <div><small>任务 ID</small><span>{publication.taskId ? <><code>{publication.taskId}</code><CopyValueButton label="任务 ID" value={publication.taskId} /></> : <Text type="secondary">尚未派发</Text>}</span></div>
              <div><small>提交来源</small><strong>{publicationSourceLabel(publication.source)}</strong></div>
              <div><small>发布修订</small><strong>R{publication.revision}</strong></div>
            </div>
            <div className="wb-publication-result-products">
              <small>WB 商品 / nmID</small>
              {links.length ? <div>{links.map((link) => <a key={link.nmId} href={link.url} target="_blank" rel="noreferrer" aria-label={`打开 ${publication.storeDisplayName || publication.storeAlias} 的 WB 商品 ${link.nmId}`}>{link.nmId} <LinkOutlined /></a>)}</div> : <Text type="secondary">WB 尚未返回 nmID</Text>}
            </div>
            {hasError && <div className="wb-publication-result-error" role="alert"><strong>{publication.errorCode || '发布错误'}</strong><span>{publication.errorMessage || '任务需要人工检查'}</span></div>}
            <footer><ClockCircleOutlined /><span>更新于 {dayjs(publication.updatedAt).format('YYYY-MM-DD HH:mm:ss')}</span>{publication.completedAt && <Text type="secondary">完成 {dayjs(publication.completedAt).format('MM-DD HH:mm:ss')}</Text>}</footer>
          </article>;
        })}
      </div>
    </>}
  </Card>;
}

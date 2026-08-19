import { AppstoreAddOutlined, ClockCircleOutlined, LinkOutlined, ReloadOutlined, RocketOutlined, SafetyCertificateOutlined, ShopOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import type { OzonPublication } from './api/client';
import { CopyValueButton } from './copy-value';
import {
  ozonPublicationActions,
  ozonPublicationCanRecheckLocally,
  ozonPublicationProducts,
  ozonPublicationStatusMeta,
  summarizeOzonPublications
} from './ozon-publication-results-utils';

const { Text } = Typography;

export function OzonPublicationResults({
  publications,
  loading,
  refreshing,
  error,
  busyAction,
  onRefresh,
  onSync,
  onRepublish,
  onCancel,
  onRecheck,
  onCompatibleAppend,
  remoteReadbackEnabled = false
}: {
  publications: OzonPublication[];
  loading: boolean;
  refreshing: boolean;
  error?: Error | null;
  busyAction?: { publicationId: string; action: 'sync' | 'republish' | 'cancel' | 'recheck' | 'compatible-append' };
  onRefresh: () => void;
  onSync: (publication: OzonPublication) => void;
  onRepublish: (publication: OzonPublication) => void;
  onCancel: (publication: OzonPublication) => void;
  onRecheck: (publication: OzonPublication) => void;
  onCompatibleAppend: (publication: OzonPublication) => void;
  remoteReadbackEnabled?: boolean;
}) {
  const summary = summarizeOzonPublications(publications);
  const ordered = [...publications].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return <Card
    className="ozon-publication-results"
    loading={loading}
    title={<div className="ozon-publication-results-title"><span><ShopOutlined /></span><div><small>STORE PUBLICATIONS</small><strong>店铺发布结果</strong></div></div>}
    extra={<Space size={7}><Tag color={summary.active ? 'processing' : summary.attention ? 'volcano' : summary.allSucceeded ? 'green' : 'default'}>{summary.total} 条店铺记录</Tag><Button aria-label="刷新店铺发布结果" size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>刷新</Button></Space>}
  >
    {error ? <Alert showIcon type="error" message="店铺发布结果加载失败" description={error.message} action={<Button onClick={onRefresh}>重试</Button>} /> : !ordered.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未提交到任何 OZON 店铺" /> : <>
      <div className="ozon-publication-summary" aria-label="OZON 店铺发布汇总">
        <div><small>店铺记录</small><strong>{summary.total}</strong></div>
        <div><small>正在执行</small><strong>{summary.active}</strong></div>
        <div><small>上品完成</small><strong>{summary.succeeded}</strong></div>
        <div><small>需要处理</small><strong>{summary.attention}</strong></div>
      </div>
      <div className="ozon-publication-result-list" role="list" aria-label="OZON 店铺发布结果">
        {ordered.map((publication) => {
          const status = ozonPublicationStatusMeta[publication.status];
          const products = ozonPublicationProducts(publication);
          const storeName = publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot;
          const { canRepublish, canCancel, canRecheck, canCompatibleAppend } = ozonPublicationActions(publication.status);
          const canRecheckLocally = ozonPublicationCanRecheckLocally(publication);
          const recheckEnabled = canRecheckLocally || remoteReadbackEnabled;
          const actionLoading = (action: NonNullable<typeof busyAction>['action']) => busyAction?.publicationId === publication.id && busyAction.action === action;
          return <article className={`ozon-publication-result is-${publication.status.toLowerCase().replace('_', '-')}`} role="listitem" aria-label={`${storeName} 发布结果`} key={publication.id}>
            <header className="ozon-publication-result-head">
              <span className="ozon-publication-result-mark" aria-hidden="true" />
              <div><strong title={storeName}>{storeName}</strong><code title={publication.storeAliasSnapshot}>{publication.storeAliasSnapshot} · R{publication.revision}</code></div>
              <Tag color={status.color}>{status.label}</Tag>
              <Space className="ozon-publication-result-actions" size={4} wrap>
                <Tooltip title="仅将本地任务记录同步到 publication，不会请求 OZON Seller API"><Button size="small" icon={<ReloadOutlined />} loading={actionLoading('sync')} onClick={() => onSync(publication)}>同步本地任务状态</Button></Tooltip>
                {canRecheck && <Tooltip title={canRecheckLocally ? '复用固定 publication 与任务身份，重新检查尚未进入平台的原 attempt' : remoteReadbackEnabled ? '通过 publication 冻结合同重新检查 OZON 平台状态' : '等待受控 OZON 多店 fleet 部署；本地状态同步不能替代平台回查'}><span><Button size="small" icon={<SafetyCertificateOutlined />} disabled={!recheckEnabled} loading={actionLoading('recheck')} onClick={recheckEnabled ? () => onRecheck(publication) : undefined}>{canRecheckLocally ? '重检原任务' : remoteReadbackEnabled ? '重新检查平台' : '等待多店 fleet 部署'}</Button></span></Tooltip>}
                {canCompatibleAppend && <Button size="small" icon={<AppstoreAddOutlined />} loading={actionLoading('compatible-append')} onClick={() => onCompatibleAppend(publication)}>兼容追加</Button>}
                {canRepublish && <Button size="small" icon={<RocketOutlined />} loading={actionLoading('republish')} onClick={() => onRepublish(publication)}>重新上品</Button>}
                {canCancel && <Button danger type="text" size="small" icon={<StopOutlined />} loading={actionLoading('cancel')} onClick={() => onCancel(publication)}>取消</Button>}
              </Space>
            </header>
            <div className="ozon-publication-result-facts">
              <div><small>Publication ID</small><span><code>{publication.id}</code><CopyValueButton label="Publication ID" value={publication.id} /></span></div>
              <div><small>任务 ID</small><span>{publication.taskId ? <><code>{publication.taskId}</code><CopyValueButton label="任务 ID" value={publication.taskId} /></> : <Text type="secondary">尚未派发</Text>}</span></div>
              <div><small>仓库 / 履约</small><strong title={publication.warehouseName || publication.warehouseId}>{publication.warehouseName || publication.warehouseId} · {publication.fulfillmentMode}</strong></div>
              <div><small>合同币种</small><strong>{publication.accountCurrency || '—'}</strong></div>
            </div>
            <div className="ozon-publication-result-products">
              <strong>店铺 Offer 与 OZON 身份</strong>
              {products.length ? <div>{products.map((product) => <div className="ozon-publication-product" key={product.offerId}>
                <code title={product.offerId}>{product.offerId}</code>
                <span>{product.ozonSku || product.productId || '等待 OZON 返回身份'}</span>
                {product.url && <a href={product.url} target="_blank" rel="noreferrer" aria-label={`打开 ${storeName} 的 OZON 商品 ${product.ozonSku || product.offerId}`}>打开商品 <LinkOutlined /></a>}
              </div>)}</div> : <Text type="secondary">尚未生成 Offer</Text>}
            </div>
            {(publication.errorCode || publication.errorMessage) && <div className="ozon-publication-result-error" role="alert"><strong>{publication.errorCode || '发布错误'}</strong><span>{publication.errorMessage || '该店铺任务需要人工检查'}</span></div>}
            <footer><ClockCircleOutlined /><span>更新于 {dayjs(publication.updatedAt).format('YYYY-MM-DD HH:mm:ss')}</span>{publication.completedAt && <Text type="secondary">完成 {dayjs(publication.completedAt).format('MM-DD HH:mm:ss')}</Text>}</footer>
          </article>;
        })}
      </div>
    </>}
  </Card>;
}

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Progress, Space, Tag, Typography } from 'antd';
import { api, connectReviewOperationEvents } from './api/client';

const labels = { QUEUED: '等待处理', RUNNING: '处理中', RETRY_WAIT: '等待重试', NEEDS_ATTENTION: '需要核对', SUCCEEDED: '已完成', PARTIAL_SUCCESS: '部分完成', FAILED: '处理失败' };
const finalStates = new Set(['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'NEEDS_ATTENTION']);
export function ReviewOperationsPanel() {
  const client = useQueryClient();
  const seen = useRef(new Map<string, string>());
  const query = useQuery({ queryKey: ['review-operations'], queryFn: api.reviewOperations, refetchInterval: 2000 });
  const retry = useMutation({ mutationFn: api.retryReviewOperation, onSuccess: () => client.invalidateQueries({ queryKey: ['review-operations'] }) });
  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: ['review-operations'] }); };
    const close = connectReviewOperationEvents(refresh, refresh);
    window.addEventListener('merchroute-review-operation-accepted', refresh);
    return () => { close(); window.removeEventListener('merchroute-review-operation-accepted', refresh); };
  }, [client]);
  useEffect(() => {
    for (const row of query.data?.items || []) {
      const previous = seen.current.get(row.operationId);
      seen.current.set(row.operationId, row.status);
      if (finalStates.has(row.status) && previous !== row.status) {
        void client.invalidateQueries({ queryKey: ['pending'] });
        void client.invalidateQueries({ queryKey: ['history'] });
        void client.invalidateQueries({ queryKey: ['stages'] });
        for (const subject of row.subjectKeys.filter((key) => key.startsWith('task:'))) {
          void client.invalidateQueries({ queryKey: ['task', subject.slice(5)] });
        }
      }
    }
  }, [client, query.data]);
  const active = (query.data?.items || []).filter((row) => row.status !== 'SUCCEEDED' && (row.status !== 'FAILED' || Date.now() - Date.parse(row.updatedAt) < 86400_000));
  const recent = (query.data?.items || []).filter((row) => row.status === 'SUCCEEDED').slice(0, 1);
  const items = [...active, ...recent];
  if (query.isError) return <Alert type="warning" showIcon message="暂时无法读取处理进度，正在重新连接。请保留原请求，勿重复创建投递。" style={{ marginBottom: 12 }} />;
  if (!items.length) return null;
  return <Card size="small" title="审核与投递进度" style={{ marginBottom: 16 }}>
    <Space direction="vertical" style={{ width: '100%' }}>
      {items.map((row) => <div key={row.operationId} data-testid="review-operation">
        <Space wrap>
          <Tag color={row.status === 'SUCCEEDED' ? 'green' : row.status === 'NEEDS_ATTENTION' || row.status === 'FAILED' ? 'red' : 'blue'}>{labels[row.status]}</Tag>
          <Typography.Text>{row.kind === 'APPROVE' ? '审核提交' : row.kind === 'BATCH' ? '批量投递' : '投递重试'}</Typography.Text>
          <Typography.Text type="secondary" copyable>{row.operationId}</Typography.Text>
          {(['FAILED', 'PARTIAL_SUCCESS', 'NEEDS_ATTENTION'].includes(row.status) || row.error?.code === 'STATE_STORE_UNAVAILABLE') && <Button size="small" loading={retry.isPending} onClick={() => retry.mutate(row.operationId)}>{row.error?.code === 'STATE_STORE_UNAVAILABLE' ? '恢复处理' : row.status === 'NEEDS_ATTENTION' ? '重新核对结果' : '重试未完成部分'}</Button>}
        </Space>
        {row.progress && row.status === 'RUNNING' && <div>
          <Typography.Text>{row.progress.step}</Typography.Text>
          {Boolean(row.progress.totalBytes) && <Progress size="small" percent={Math.min(99, Math.round((row.progress.copiedBytes || 0) * 100 / row.progress.totalBytes!))} />}
          {Date.now() - Date.parse(row.progress.updatedAt) > 60_000 && <Typography.Text type="warning"> 处理仍在继续，暂未收到新进度</Typography.Text>}
        </div>}
        {row.error && <Typography.Paragraph type="danger" style={{ marginBottom: 0 }}>{row.error.message}</Typography.Paragraph>}
        {row.status === 'NEEDS_ATTENTION' && <Typography.Paragraph style={{ marginBottom: 0 }}>系统会核对原投递记录；无法确认时继续保留任务，不会自动再次入队。</Typography.Paragraph>}
      </div>)}
      {retry.isError && <Typography.Text type="danger">{retry.error.message}</Typography.Text>}
    </Space>
  </Card>;
}

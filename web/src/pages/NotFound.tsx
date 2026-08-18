// 404 页面
import { Link } from 'react-router-dom';
import { Card } from '../components/ui';

export default function NotFound(): JSX.Element {
  return (
    <div>
      <div className="page-title">页面不存在</div>
      <Card>
        <p className="muted">您访问的页面不存在或已被移除。</p>
        <p><Link className="link" to="/">返回总览 →</Link></p>
      </Card>
    </div>
  );
}

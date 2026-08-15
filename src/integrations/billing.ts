// 计费核验：summary / modelTrend / modelTop / records
// 响应结构基于实测：billing/personal?section=xxx&range=7days
import type { Http } from './http.js';

export interface TrendSeries {
  name?: string;
  values?: number[];
}

export class Billing {
  http: Http;
  url: string;

  constructor(http: Http, billingUrl: string) {
    this.http = http;
    this.url = billingUrl;
  }

  async summary(): Promise<Record<string, any>> {
    const { json } = await this.http.api('账单汇总', 'GET', this.url + '?section=summary&range=7days');
    return (json.data as Record<string, any>) || {};
  }

  /** 返回 { labels, series:[{name,values}] } */
  async modelTrend(): Promise<{ labels: string[]; series: TrendSeries[] }> {
    const { json } = await this.http.api('模型趋势', 'GET', this.url + '?section=modelTrend&range=7days');
    const d = json.data || {};
    return { labels: d.labels || [], series: d.series || [] };
  }

  /** 返回 { total, items:[{rank,name,score,count}] } */
  async modelTop(): Promise<{ total: number; items: any[] }> {
    const { json } = await this.http.api('模型TOP5', 'GET', this.url + '?section=modelTop&range=7days');
    const d = json.data || {};
    return { total: d.total || 0, items: d.items || [] };
  }

  /** 返回 records 列表 */
  async records(limit = 50): Promise<any[]> {
    const { json } = await this.http.api('消费明细', 'GET', this.url + `?section=records&page=1&limit=${limit}&range=7days`);
    const d = json.data || {};
    return d.list || d.rows || d.records || [];
  }
}

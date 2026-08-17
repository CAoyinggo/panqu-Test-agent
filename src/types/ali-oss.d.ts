declare module 'ali-oss' {
  interface OSSOptions {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    region?: string;
    secure?: boolean;
    timeout?: number;
  }

  interface PutObjectResult {
    name: string;
    url: string;
    res: {
      status: number;
      headers: Record<string, string>;
    };
  }

  interface PutObjectOptions {
    headers?: Record<string, string>;
    timeout?: number;
  }

  export default class OSS {
    constructor(options: OSSOptions);
    put(name: string, file: Buffer | string, options?: PutObjectOptions): Promise<PutObjectResult>;
    delete(name: string): Promise<{ res: { status: number } }>;
    get(name: string): Promise<{ content: Buffer; res: { status: number } }>;
    list(query: { prefix?: string; delimiter?: string; maxKeys?: number }): Promise<{ objects: Array<{ name: string; url: string }> }>;
  }
}

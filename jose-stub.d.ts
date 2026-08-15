declare module "jose" {
  export function createRemoteJWKSet(url: URL): any;
  export function jwtVerify(token: string, jwks: any, options?: any): Promise<any>;
}

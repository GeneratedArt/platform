/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_BASE?: string;
  readonly PUBLIC_RENDERER_BASE?: string;
  readonly PUBLIC_CHAIN_ID?: string;
  readonly PUBLIC_FACTORY_ADDRESS?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }

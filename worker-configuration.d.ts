interface Env {
  RUNNING_IN_DOCKER: Settings;
  DEFAULT_NUM_CTX: Settings;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GROQ_API_KEY: string;
  HuggingFace_API_KEY: string;
  OPEN_ROUTER_API_KEY: string;
  OLLAMA_API_BASE_URL: string;
  OPENAI_LIKE_API_KEY: string;
  OPENAI_LIKE_API_BASE_URL: string;
  OPENAI_LIKE_API_MODELS: string;
  TOGETHER_API_KEY: string;
  TOGETHER_API_BASE_URL: string;
  DEEPSEEK_API_KEY: string;
  LMSTUDIO_API_BASE_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  MISTRAL_API_KEY: string;
  XAI_API_KEY: string;
  PERPLEXITY_API_KEY: string;
  AWS_BEDROCK_CONFIG: string;
  NIMBUS_API_KEY: string;
  NIMBUS_API_BASE_URL: string;
  NIMBUS_ONLY: string;

  // These four are read by app/lib/.server/nimbus-sso.ts, and until 2026-08-02
  // none of them was declared here — which silently disabled Builder's login.
  //
  // bindings.sh builds wrangler's --binding flags by grepping THIS FILE for
  // /[A-Z_]+:/ (it only reads .env.local, which .dockerignore excludes from the
  // image). A variable that is not declared here therefore never reaches
  // context.cloudflare.env, no matter that it is set correctly on the container.
  //
  // NIMBUS_SSO_SHARED_SECRET was set in Azure the whole time. getNimbusSharedSecret()
  // returned undefined, the loader short-circuited to {enabled:false}, and the
  // result was that builder.nimbusapi.net answered 200 to anyone with the URL,
  // showed "Guest User", left ?nimbus_token= in the address bar (the code that
  // strips it only runs after a successful verify), and spent the shared
  // NIMBUS_API_KEY for whoever asked.
  //
  // bindings.sh emits a binding only `if [ -n "${!var}" ]`, so declaring the
  // three optional ones costs nothing when they are unset.
  NIMBUS_SSO_SHARED_SECRET: string;
  NIMBUS_SSO_DISABLED: string;
  NIMBUS_DASHBOARD_URL: string;
  NIMBUS_SSO_COOKIE_DOMAIN: string;
  DEFAULT_PROVIDER: string;
  DEFAULT_MODEL: string;
}

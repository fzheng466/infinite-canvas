export const modelChannelProtocols = [
    { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com" },
    { value: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com" },
    { value: "grok2api", label: "Grok2API", baseUrl: "" },
    { value: "metaso", label: "MiniMax & METASO", baseUrl: "https://metaso.cn/api/minimax", apiKeyUrl: "https://metaso.cn/minimax-h3/" },
    { value: "apimart", label: "APIMart", baseUrl: "https://api.apimart.ai/v1", apiKeyUrl: "https://apimart.ai/register", directRequestPlan: true },
    { value: "88api", label: "88API", baseUrl: "https://88api.ai/v1", apiKeyUrl: "https://88api.ai/sign-up" },
    { value: "kie", label: "KIE", baseUrl: "https://api.kie.ai/api/v1", directRequestPlan: true },
    { value: "autodl", label: "AutoDL", baseUrl: "https://autodl.art", directRequestPlan: true },
    { value: "ark", label: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", directRequestPlan: true },
    { value: "mimo", label: "MiMo", baseUrl: "https://api.xiaomimimo.com", apiKeyUrl: "https://platform.xiaomimimo.com/" },
] as const;

export type ModelChannelProtocol = (typeof modelChannelProtocols)[number]["value"];
export type DirectAIProvider = Extract<(typeof modelChannelProtocols)[number], { directRequestPlan: true }>["value"];
export const modelChannelProtocolOptions = modelChannelProtocols.map(({ value, label }) => ({ label, value }));
export const modelChannelDefaultBaseUrls = Object.fromEntries(modelChannelProtocols.map(({ value, baseUrl }) => [value, baseUrl])) as Record<ModelChannelProtocol, string>;
export const modelChannelApiKeyUrls = Object.fromEntries(modelChannelProtocols.flatMap((protocol) => "apiKeyUrl" in protocol ? [[protocol.value, protocol.apiKeyUrl]] : [])) as Partial<Record<ModelChannelProtocol, string>>;

const directRequestProviders: ReadonlySet<string> = new Set(modelChannelProtocols.flatMap((protocol) => "directRequestPlan" in protocol && protocol.directRequestPlan === true ? [protocol.value] : []));

export function directAIProviderForProtocol(protocol: string): DirectAIProvider | null {
    return directRequestProviders.has(protocol) ? protocol as DirectAIProvider : null;
}

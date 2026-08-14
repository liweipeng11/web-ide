export type FakeModelResponse = {
  text: string;
  signals?: readonly string[];
  usage?: { inputTokens: number; outputTokens: number };
};

/** 固定响应模型，确保阶段 0 基线测试从不发起真实 Provider 请求。 */
export class FakeModel {
  private readonly responses: ReadonlyMap<string, FakeModelResponse>;

  constructor(responses: Record<string, FakeModelResponse>) {
    this.responses = new Map(Object.entries(responses));
  }

  async complete(input: { scenarioId: string }): Promise<FakeModelResponse> {
    const response = this.responses.get(input.scenarioId);
    if (!response) {
      // 未配置响应必须显式失败，避免测试误以为已覆盖外部模型行为。
      throw new Error(`Fake Model 未配置场景响应：${input.scenarioId}`);
    }
    return structuredClone(response);
  }
}

// Vue2 模板接口接收的原始片段结构。
export interface Vue2TemplateFragment {
  section: string;
  code: string;
}

// 经过请求层校验和解码后的标准参数。
export interface NormalizedVue2TemplateRequest {
  template: string;
  fragments: Vue2TemplateFragment[];
}

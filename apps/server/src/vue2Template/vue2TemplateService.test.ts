import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../errors.js";
import { parseVue2TemplateRequest } from "./requestParser.js";
import { applyVue2TemplateFragments } from "./vue2TemplateService.js";

const baseTemplate = `<template>
  <div>{{ msg }}</div>
</template>

<script>
export default {
  data() {
    return {
      msg: "hello"
    };
  },
  methods: {
    save() {
      return this.msg;
    }
  }
}
</script>
`;

test("applyVue2TemplateFragments merges data and methods by property key", () => {
  const result = applyVue2TemplateFragments(baseTemplate, [
    { section: "data", code: "count: 0" },
    { section: "methods", code: "save() { return this.count; }, reset() { this.count = 0; }" }
  ]);

  assert.match(result, /count: 0/);
  assert.match(result, /save\(\) \{ return this\.count; \}/);
  assert.match(result, /reset\(\) \{ this\.count = 0; \}/);
});

test("applyVue2TemplateFragments replaces template content", () => {
  const result = applyVue2TemplateFragments(baseTemplate, [
    { section: "template", code: "<section>{{ count }}</section>" }
  ]);

  assert.match(result, /<template>\n  <section>\{\{ count \}\}<\/section>\n<\/template>/);
});

test("applyVue2TemplateFragments adds lifecycle hook and object section", () => {
  const result = applyVue2TemplateFragments(baseTemplate, [
    { section: "mounted", code: "mounted() { this.save(); }" },
    { section: "computed", code: "title() { return this.msg.toUpperCase(); }" }
  ]);

  assert.match(result, /mounted\(\) \{ this\.save\(\); \}/);
  assert.match(result, /computed: \{/);
  assert.match(result, /title\(\) \{ return this\.msg\.toUpperCase\(\); \}/);
});

test("applyVue2TemplateFragments accepts wrapped object section code", () => {
  const result = applyVue2TemplateFragments(baseTemplate, [
    { section: "methods", code: "methods: { save() { return 'wrapped'; } }" }
  ]);

  assert.match(result, /methods: \{/);
  assert.match(result, /save\(\) \{ return 'wrapped'; \}/);
  assert.doesNotMatch(result, /methods: \{\s*\{/);
});

test("applyVue2TemplateFragments preserves replace-only object values", () => {
  const result = applyVue2TemplateFragments(baseTemplate, [
    { section: "model", code: "model: { prop: 'checked', event: 'change' }" },
    { section: "mixins", code: "mixins: [formMixin]" }
  ]);

  assert.match(result, /model: \{ prop: 'checked', event: 'change' \}/);
  assert.match(result, /mixins: \[formMixin\]/);
  assert.doesNotMatch(result, /model: prop:/);
});

test("applyVue2TemplateFragments supports documented Vue2 sections", () => {
  const fragments = [
    { section: "data", code: "count: 0" },
    { section: "methods", code: "save() { return this.count; }" },
    { section: "computed", code: "total() { return this.count * 2; }" },
    { section: "watch", code: "count(val) { console.log(val); }" },
    { section: "props", code: "title: { type: String, default: '' }" },
    { section: "components", code: "MyComp: MyComp" },
    { section: "filters", code: "format(v) { return String(v); }" },
    { section: "created", code: "created() { this.load(); }" },
    { section: "mounted", code: "mounted() { this.init(); }" },
    { section: "beforeCreate", code: "beforeCreate() {}" },
    { section: "beforeMount", code: "beforeMount() {}" },
    { section: "beforeUpdate", code: "beforeUpdate() {}" },
    { section: "updated", code: "updated() {}" },
    { section: "activated", code: "activated() {}" },
    { section: "deactivated", code: "deactivated() {}" },
    { section: "beforeDestroy", code: "beforeDestroy() {}" },
    { section: "destroyed", code: "destroyed() {}" },
    { section: "errorCaptured", code: "errorCaptured(err, vm, info) { return false; }" },
    { section: "serverPrefetch", code: "serverPrefetch() { return this.fetchData(); }" },
    { section: "beforeRouteEnter", code: "beforeRouteEnter(to, from, next) { next(); }" },
    { section: "mixins", code: "mixins: [myMixin]" },
    { section: "model", code: "model: { prop: 'checked', event: 'change' }" }
  ];

  const result = applyVue2TemplateFragments(baseTemplate, fragments);

  for (const fragment of fragments) {
    assert.match(result, new RegExp(`${fragment.section}\\s*[:(]`));
  }
});

test("parseVue2TemplateRequest accepts fragments as base64 json string", () => {
  const encodedFragments = Buffer.from(JSON.stringify([{ section: "data", code: "count: 0" }]), "utf8").toString("base64");
  const request = parseVue2TemplateRequest({
    template: baseTemplate,
    fragments: encodedFragments
  });

  assert.equal(request.fragments[0]?.section, "data");
  assert.equal(request.fragments[0]?.code, "count: 0");
});

test("applyVue2TemplateFragments rejects invalid JavaScript fragment", () => {
  assert.throws(
    () => applyVue2TemplateFragments(baseTemplate, [{ section: "methods", code: "save( {" }]),
    (error) => error instanceof HttpError && error.status === 400 && error.message.includes("Failed to parse replacement code")
  );
});

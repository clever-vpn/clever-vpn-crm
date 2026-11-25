/**
 * 给 DeepSeek Responses API `text.format.json_schema` 用的输出 schema。
 *
 * 和 `docs/payment-templates.schema.json` 同源：mapping 部分直接复用其中的
 * `$defs`，避免 prompt schema 与模板 schema 漂移；根只保留 AI 输出信封。
 *
 * 注意：这里只约束**结构**。role/三端点/data_path 位置/金额单位等语义仍由
 * `validateMapping` 校验；不要因为 schema 通过就跳过校验。
 */
import templateSchema from "../../docs/payment-templates.schema.json";

interface TemplateSchemaFile {
  $defs: Record<string, unknown>;
}

const source = templateSchema as unknown as TemplateSchemaFile;

export const AI_OUTPUT_SCHEMA_NAME = "payment_template_draft";

export const AI_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["classification", "template", "evidence", "uncertainty"],
  properties: {
    classification: { enum: ["generic_mapping", "driver", "unsupported"] },
    template: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["schema_version", "id", "name", "source", "mapping"],
          properties: {
            schema_version: { const: 2 },
            id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
            name: { type: "string" },
            description: { type: "string" },
            source: { const: "ai" },
            mapping: { $ref: "#/$defs/mapping" },
          },
        },
      ],
    },
    evidence: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "quote"],
        properties: {
          section: { type: "string" },
          quote: { type: "string" },
        },
      },
    },
    uncertainty: {
      type: "array",
      maxItems: 20,
      items: { type: "string" },
    },
  },
  $defs: source.$defs,
} as const;

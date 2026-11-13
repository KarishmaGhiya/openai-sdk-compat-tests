import "@azure/openai/types";
import type { AzureOpenAI } from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/index";

type Inputs = {
  model: string;
  tokenParameter: "max_tokens" | "max_completion_tokens";
  maxTokens: number;
  dataSources?: ChatCompletionCreateParamsNonStreaming["data_sources"];
  groundingPrompt?: string;
};
type Options = { signal: AbortSignal; timeout: number; maxRetries: number };
type Observe = (field: string, value: unknown) => void;

function check(condition: unknown, assertion: string): asserts condition {
  if (!condition) throw Object.assign(new Error("Companion scenario assertion failed"), { compatibilityAssertion: assertion });
}

export async function execute(
  client: AzureOpenAI, feature: string, inputs: Inputs, options: Options, observe: Observe,
) {
  const messages = [{ role: "user" as const, content: feature.startsWith("grounding")
    ? inputs.groundingPrompt! : "Reply with the single word compatibility." }];
  const chatBody = {
    model: inputs.model, messages,
    ...(inputs.tokenParameter === "max_completion_tokens"
      ? { max_completion_tokens: inputs.maxTokens } : { max_tokens: inputs.maxTokens }),
  };
  if (feature === "chat" || feature === "grounding") {
    const body: ChatCompletionCreateParamsNonStreaming = {
      ...chatBody, ...(feature === "grounding" ? { data_sources: inputs.dataSources } : {}),
    };
    if (feature === "grounding") observe("ChatCompletionCreateParamsNonStreaming.data_sources", body.data_sources);
    const response = await client.chat.completions.create(body, options);
    check(response.choices[0]?.message.content?.trim(), "chat-output");
    if (feature === "chat") {
      observe("ChatCompletion.prompt_filter_results", response.prompt_filter_results);
      for (const choice of response.choices) observe("ChatCompletion.Choice.content_filter_results", choice.content_filter_results);
    } else {
      for (const choice of response.choices) {
        observe("ChatCompletionMessage.context", choice.message.context);
        check(choice.message.context?.citations?.length, "grounding-citations");
      }
    }
    return;
  }
  if (feature === "chat-stream" || feature === "grounding-stream") {
    const body: ChatCompletionCreateParamsStreaming = {
      ...chatBody, stream: true, ...(feature === "grounding-stream" ? { data_sources: inputs.dataSources } : {}),
    };
    if (feature === "grounding-stream") observe("ChatCompletionCreateParamsStreaming.data_sources", body.data_sources);
    const stream = await client.chat.completions.create(body, options);
    let text = "";
    let finished = false;
    let citations = false;
    for await (const event of stream) {
      options.signal.throwIfAborted();
      if (feature === "chat-stream") observe("ChatCompletionChunk.prompt_filter_results", event.prompt_filter_results);
      for (const choice of event.choices) {
        text += choice.delta.content ?? "";
        finished ||= Boolean(choice.finish_reason);
        if (feature === "chat-stream") observe("ChatCompletionChunk.Choice.content_filter_results", choice.content_filter_results);
        else {
          observe("ChatCompletionChunk.Choice.Delta.context", choice.delta.context);
          citations ||= Boolean(choice.delta.context?.citations?.length);
        }
      }
    }
    options.signal.throwIfAborted();
    check(text.trim() && finished, "completed-stream");
    if (feature === "grounding-stream") check(citations, "grounding-citations");
    return;
  }
  if (feature === "completions") {
    const response = await client.completions.create({
      model: inputs.model, prompt: "Reply with compatibility.", max_tokens: inputs.maxTokens,
    }, options);
    check(response.choices[0]?.text.trim(), "completion-output");
    observe("Completion.prompt_filter_results", response.prompt_filter_results);
    for (const choice of response.choices) observe("CompletionChoice.content_filter_results", choice.content_filter_results);
    return;
  }
  if (feature === "images") {
    const response = await client.images.generate({
      model: inputs.model, prompt: "A plain blue square on white.", n: 1, size: "1024x1024",
    }, options);
    check(response.data?.some((image) => image.url || image.b64_json), "image-output");
    observe("ImagesResponse.prompt_filter_results", response.prompt_filter_results);
    observe("ImagesResponse.content_filter_results", response.content_filter_results);
    return;
  }
  if (feature === "upload-parts") {
    const data = new File(["compatibility\n"], "compat.txt", { type: "text/plain" });
    const upload = await client.uploads.create({
      bytes: data.size, filename: data.name, mime_type: data.type, purpose: "assistants",
    }, options);
    check(upload.id, "upload-id");
    try {
      const part = await client.uploads.parts.create(upload.id, { data }, options);
      check(part.id, "upload-part-id");
      // The companion's root UploadPart augmentation does not reach this method's result.
      observe("UploadPart.azure_block_id", Reflect.get(part, "azure_block_id"));
    } finally {
      const cancelled = await client.uploads.cancel(upload.id, { timeout: 30_000, maxRetries: 0 });
      check(cancelled.status === "cancelled", "upload-cleanup");
    }
    return;
  }
  throw new Error("Unknown Azure companion scenario");
}

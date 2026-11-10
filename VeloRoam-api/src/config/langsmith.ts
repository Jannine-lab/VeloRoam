import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client, isTracingEnabled } from 'langsmith';

let client: Client | undefined;

export function langSmithProjectCallbacks(): LangChainTracer[] | undefined {
  const projectId = process.env.LANGSMITH_PROJECT_ID?.trim();
  if (!projectId || !isTracingEnabled()) return;

  const sdk = client ??= new Client({
    blockOnRootRunFinalization: process.env.LANGCHAIN_CALLBACKS_BACKGROUND === 'false' || undefined
  });
  const tracer = new LangChainTracer({
    client: {
      createRun(run) {
        // LangChain supplies a project name. Use the existing project's ID on the wire.
        const target = { ...run, project_name: undefined, session_name: undefined, session_id: projectId };
        return sdk.createRun(target);
      },
      updateRun(id, run) {
        return sdk.updateRun(id, { ...run, session_name: undefined, session_id: projectId });
      }
    }
  });
  return [tracer];
}

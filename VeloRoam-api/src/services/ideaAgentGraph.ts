import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

export interface PlaceCandidateRef { id: string; type: 'point' | 'segment'; name: string }
export interface PlaceContext { query: string; terms: string[]; candidates: PlaceCandidateRef[]; selectedId: string | null; area: string | null }

// Client-held context is bounded and used only to select IDs from a fresh public-data lookup.
export function sanitizePlaceContext(value: any): PlaceContext | null {
  if (!value || typeof value.query !== 'string') return null;
  const query = value.query.trim().slice(0, 80);
  if (!query) return null;
  const candidates: PlaceCandidateRef[] = Array.isArray(value.candidates) ? value.candidates.flatMap((item: any) => {
    if (!item || typeof item.id !== 'string' || !/^(point|segment):[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
      (item.type !== 'point' && item.type !== 'segment') || !item.id.startsWith(item.type + ':') || typeof item.name !== 'string') return [];
    return [{ id: item.id, type: item.type, name: item.name.trim().slice(0, 80) }];
  }).slice(0, 12) : [];
  const terms: string[] = Array.isArray(value.terms) ? value.terms.filter((x: unknown): x is string => typeof x === 'string' && x.trim().length >= 2 && x.trim().length <= 80).map((x: string) => x.trim()).slice(0, 3) : [];
  return { query, terms, candidates, selectedId: typeof value.selectedId === 'string' && candidates.some(x => x.id === value.selectedId) ? value.selectedId : null,
    area: typeof value.area === 'string' ? value.area.trim().slice(0, 80) || null : null };
}

const State = Annotation.Root({
  interpretation: Annotation<any>(),
  grounding: Annotation<any>(),
  result: Annotation<any>()
});

/** Each request supplies its previous, bounded conversation context; no shared process-global session. */
export async function runIdeaGraph<T>(steps: {
  interpret: () => Promise<any>;
  shouldGround: (interpretation: any) => boolean;
  ground: (interpretation: any) => Promise<any>;
  respond: (interpretation: any, grounding: any) => Promise<T>;
}): Promise<T> {
  const graph = new StateGraph(State)
    .addNode('interpret', async () => ({ interpretation: await steps.interpret() }))
    .addNode('ground', async state => ({ grounding: await steps.ground(state.interpretation) }))
    .addNode('respond', async state => ({ result: await steps.respond(state.interpretation, state.grounding) }))
    .addEdge(START, 'interpret')
    .addConditionalEdges('interpret', state => steps.shouldGround(state.interpretation) ? 'ground' : 'respond')
    .addEdge('ground', 'respond')
    .addEdge('respond', END)
    .compile();
  const state = await graph.invoke({});
  return state.result as T;
}

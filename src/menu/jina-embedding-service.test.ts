import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The service reads config at import time via env; set before importing config.
process.env.JINA_API_KEY = 'test-key';
process.env.EMBEDDING_MODEL = 'jina-embeddings-v3';
process.env.EMBEDDING_DIMENSIONS = '4';

const { JinaEmbeddingService } = await import('./jina-embedding-service.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('JinaEmbeddingService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends model/task/dimensions and the full batch in one request', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0, 0] },
          { index: 1, embedding: [0, 1, 0, 0] },
        ],
      }),
    );

    const svc = new JinaEmbeddingService();
    const out = await svc.embedBatch(['a', 'b'], 'passage');

    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain('api.jina.ai');
    expect(opts.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      model: 'jina-embeddings-v3',
      task: 'retrieval.passage',
      dimensions: 4,
      input: ['a', 'b'],
    });
  });

  it('reorders vectors by index when the API returns them out of order', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 1, embedding: [0, 1, 0, 0] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
      }),
    );

    const out = await new JinaEmbeddingService().embedBatch(['a', 'b']);
    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  it('keeps vectors aligned to input positions when the API drops an input', async () => {
    // Sent 3 texts; API returns only indices 0 and 2 (index 1 dropped).
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 2, embedding: [0, 0, 1, 0] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
      }),
    );

    const out = await new JinaEmbeddingService().embedBatch(['a', 'b', 'c']);
    // Index 1 must be a gap ([]), not index 2's vector shifted into its slot.
    expect(out).toEqual([[1, 0, 0, 0], [], [0, 0, 1, 0]]);
  });

  it('maps the query role to retrieval.query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
    await new JinaEmbeddingService().embed('hi', 'query');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.task).toBe('retrieval.query');
  });

  it('retries once on a 5xx then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));

    const out = await new JinaEmbeddingService().embed('hi');
    expect(out).toEqual([1, 0, 0, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on a 4xx without retrying', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    await expect(new JinaEmbeddingService().embed('hi')).rejects.toThrow(/jina_http_400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] for an empty batch without calling fetch', async () => {
    const out = await new JinaEmbeddingService().embedBatch([]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

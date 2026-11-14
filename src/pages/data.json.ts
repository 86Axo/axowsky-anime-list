import type { APIRoute } from 'astro';
import dataset from '../../data/anime.json';
import { loadBakedAnnotations } from '../lib/baked-annotations';
import { toListItems } from '../lib/model';
import type { AnimeEntry } from '../lib/types';

/** Static file with the list data the browser needs for search, filters and sorting. */
export const GET: APIRoute = async () =>
  new Response(
    JSON.stringify({
      items: toListItems(dataset.entries as AnimeEntry[]),
      annotations: await loadBakedAnnotations(),
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );

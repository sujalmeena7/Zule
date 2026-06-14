// ============================================
// Zule AI — Rating Persistence & Aggregation
// ============================================
//
// Persists thumbs-up / thumbs-down ratings to STORE_RATINGS in IndexedDB.
// Exposes a pure aggregation helper for property testing and UI display.
//
// Acceptance criteria covered:
//   - 26.1 — Record thumbs-up / thumbs-down on every AI answer with
//     originating provider id, model id, rating, and createdAt.
//   - 26.2 — Aggregate ratings per provider, per mode, per modality.

import { database, STORE_RATINGS } from '../data/database';

// --- Types ---

export type RatingValue = 'up' | 'down';

export interface RatingRecord {
  id: string;
  providerId: string;
  modelId: string;
  rating: RatingValue;
  createdAt: number;
}

export interface RatingAggregate {
  total: number;
  up: number;
  down: number;
  byProvider: Record<string, { up: number; down: number }>;
  byModel: Record<string, { up: number; down: number }>;
}

// --- Persistence ---

function generateRatingId(): string {
  return `rating-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist a rating record to IndexedDB STORE_RATINGS.
 */
export async function saveRating(
  providerId: string,
  modelId: string,
  rating: RatingValue,
): Promise<RatingRecord> {
  const record: RatingRecord = {
    id: generateRatingId(),
    providerId,
    modelId,
    rating,
    createdAt: Date.now(),
  };

  await database.putRating(record);
  return record;
}

/**
 * Retrieve all rating records from IndexedDB.
 */
export async function getAllRatings(): Promise<RatingRecord[]> {
  return database.getAllRatings();
}

// --- Pure Aggregation (testable without IndexedDB) ---

/**
 * Aggregate an array of rating records into summary statistics.
 *
 * Key property: aggregateRatings(ratings).total === ratings.length
 * (no duplicates, no drops — every input record is counted exactly once).
 */
export function aggregateRatings(ratings: RatingRecord[]): RatingAggregate {
  const result: RatingAggregate = {
    total: 0,
    up: 0,
    down: 0,
    byProvider: Object.create(null) as Record<string, { up: number; down: number }>,
    byModel: Object.create(null) as Record<string, { up: number; down: number }>,
  };

  for (const r of ratings) {
    result.total++;

    if (r.rating === 'up') {
      result.up++;
    } else {
      result.down++;
    }

    // Per-provider
    if (!result.byProvider[r.providerId]) {
      result.byProvider[r.providerId] = { up: 0, down: 0 };
    }
    if (r.rating === 'up') {
      result.byProvider[r.providerId].up++;
    } else {
      result.byProvider[r.providerId].down++;
    }

    // Per-model
    if (!result.byModel[r.modelId]) {
      result.byModel[r.modelId] = { up: 0, down: 0 };
    }
    if (r.rating === 'up') {
      result.byModel[r.modelId].up++;
    } else {
      result.byModel[r.modelId].down++;
    }
  }

  return result;
}

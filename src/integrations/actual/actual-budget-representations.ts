export interface ActualBudgetRepresentation {
  readonly source: 'local' | 'remote';
  readonly id?: unknown;
  readonly cloudFileId?: unknown;
  readonly groupId?: unknown;
  readonly name?: unknown;
}

export interface CanonicalActualBudgetRepresentation {
  readonly id?: string;
  readonly cloudFileId?: string;
  readonly groupId?: string;
  readonly name: string;
  readonly localRepresentationPresent: boolean;
  readonly remoteRepresentationPresent: boolean;
}

export class ActualBudgetRepresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualBudgetRepresentationError';
  }
}

function optionalIdentity(
  value: unknown,
  field: 'id' | 'cloudFileId' | 'groupId',
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new ActualBudgetRepresentationError(
      `Actual budget ${field} must be a non-empty trimmed string when present`,
    );
  }
  return value;
}

function budgetName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new ActualBudgetRepresentationError(
      'Actual budget name must be a non-empty trimmed string',
    );
  }
  return value;
}

function remoteIdentity(representation: ActualBudgetRepresentation): {
  cloudFileId?: string;
  groupId?: string;
} {
  const cloudFileId = optionalIdentity(
    representation.cloudFileId,
    'cloudFileId',
  );
  const groupId = optionalIdentity(representation.groupId, 'groupId');
  if ((cloudFileId === undefined) !== (groupId === undefined)) {
    throw new ActualBudgetRepresentationError(
      'Actual budget remote identity must contain both cloudFileId and groupId',
    );
  }
  return cloudFileId === undefined ? {} : { cloudFileId, groupId: groupId! };
}

function assertSourceIdentity(
  representation: ActualBudgetRepresentation,
  id: string | undefined,
  cloudFileId: string | undefined,
): void {
  if (representation.source === 'remote' && id !== undefined) {
    throw new ActualBudgetRepresentationError(
      'An Actual remote budget representation cannot contain a local id',
    );
  }
  if (representation.source === 'remote' && cloudFileId === undefined) {
    throw new ActualBudgetRepresentationError(
      'An Actual remote budget representation requires a server identity',
    );
  }
  if (representation.source === 'local' && id === undefined) {
    throw new ActualBudgetRepresentationError(
      'An Actual local budget representation requires a local id',
    );
  }
}

export function actualBudgetIdentityKey(
  budget: CanonicalActualBudgetRepresentation,
): string {
  if ((budget.cloudFileId === undefined) !== (budget.groupId === undefined)) {
    throw new ActualBudgetRepresentationError(
      'Actual budget remote identity must contain both cloudFileId and groupId',
    );
  }
  if (budget.cloudFileId !== undefined && budget.groupId !== undefined) {
    return JSON.stringify(['remote', budget.cloudFileId, budget.groupId]);
  }
  if (budget.id !== undefined) {
    return JSON.stringify(['local', budget.id]);
  }
  throw new ActualBudgetRepresentationError(
    'Actual budget representation has no stable identity',
  );
}

/**
 * Actual 26.7 exposes local-cache and remote-server rows separately. Reconcile
 * all rows by the complete server identity before selecting a canonical name;
 * the remote name is authoritative when both representations are present.
 */
export function collapseActualBudgetRepresentations(
  representations: readonly ActualBudgetRepresentation[],
): CanonicalActualBudgetRepresentation[] {
  const buckets = new Map<
    string,
    {
      id?: string;
      cloudFileId?: string;
      groupId?: string;
      localName?: string;
      remoteName?: string;
      localRepresentationPresent: boolean;
      remoteRepresentationPresent: boolean;
    }
  >();
  const cloudToGroup = new Map<string, string>();
  const groupToCloud = new Map<string, string>();
  const localToBucket = new Map<string, string>();

  for (const representation of representations) {
    const normalizedName = budgetName(representation.name);
    const id = optionalIdentity(representation.id, 'id');
    const { cloudFileId, groupId } = remoteIdentity(representation);
    assertSourceIdentity(representation, id, cloudFileId);

    let bucketKey: string;
    if (cloudFileId !== undefined && groupId !== undefined) {
      const knownGroup = cloudToGroup.get(cloudFileId);
      const knownCloud = groupToCloud.get(groupId);
      if (
        (knownGroup !== undefined && knownGroup !== groupId) ||
        (knownCloud !== undefined && knownCloud !== cloudFileId)
      ) {
        throw new ActualBudgetRepresentationError(
          'Actual budget remote identities conflict',
        );
      }
      cloudToGroup.set(cloudFileId, groupId);
      groupToCloud.set(groupId, cloudFileId);
      bucketKey = JSON.stringify(['remote', cloudFileId, groupId]);
    } else if (id !== undefined) {
      bucketKey = JSON.stringify(['local', id]);
    } else {
      throw new ActualBudgetRepresentationError(
        'Actual budget representation has no stable identity',
      );
    }

    if (id !== undefined) {
      const knownBucket = localToBucket.get(id);
      if (knownBucket !== undefined && knownBucket !== bucketKey) {
        throw new ActualBudgetRepresentationError(
          'Actual local budget identity maps to conflicting records',
        );
      }
      localToBucket.set(id, bucketKey);
    }

    let bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      bucket = {
        ...(cloudFileId === undefined ? {} : { cloudFileId }),
        ...(groupId === undefined ? {} : { groupId }),
        localRepresentationPresent: false,
        remoteRepresentationPresent: false,
      };
      buckets.set(bucketKey, bucket);
    }

    if (representation.source === 'local') {
      if (bucket.localRepresentationPresent) {
        throw new ActualBudgetRepresentationError(
          'One Actual budget maps to multiple local representations',
        );
      }
      bucket.localRepresentationPresent = true;
      bucket.localName = normalizedName;
      bucket.id = id!;
    } else {
      if (bucket.remoteRepresentationPresent) {
        throw new ActualBudgetRepresentationError(
          'One Actual budget maps to multiple remote representations',
        );
      }
      bucket.remoteRepresentationPresent = true;
      bucket.remoteName = normalizedName;
    }
  }

  return [...buckets.values()].map((bucket) => ({
    ...(bucket.id === undefined ? {} : { id: bucket.id }),
    ...(bucket.cloudFileId === undefined
      ? {}
      : { cloudFileId: bucket.cloudFileId }),
    ...(bucket.groupId === undefined ? {} : { groupId: bucket.groupId }),
    name: bucket.remoteName ?? bucket.localName!,
    localRepresentationPresent: bucket.localRepresentationPresent,
    remoteRepresentationPresent: bucket.remoteRepresentationPresent,
  }));
}

/**
 * Deletion confirmation is deliberately name-independent and conservative:
 * any surviving local id, cloud file id, or sync group id blocks confirmation.
 */
export function actualBudgetIdentityAppearsInRepresentations(
  representations: readonly ActualBudgetRepresentation[],
  target: CanonicalActualBudgetRepresentation,
): boolean {
  actualBudgetIdentityKey(target);

  return representations.some((representation) => {
    const id = optionalIdentity(representation.id, 'id');
    const { cloudFileId, groupId } = remoteIdentity(representation);
    assertSourceIdentity(representation, id, cloudFileId);
    return (
      (target.id !== undefined && id === target.id) ||
      (target.cloudFileId !== undefined &&
        cloudFileId === target.cloudFileId) ||
      (target.groupId !== undefined && groupId === target.groupId)
    );
  });
}

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/publish-images.yml', import.meta.url),
  'utf8',
);
const publishStart = workflow.indexOf('\n  publish:\n');
const promoteStart = workflow.indexOf('\n  promote-latest:\n');
const publish = workflow.slice(publishStart, promoteStart);
const promote = workflow.slice(promoteStart);
const expectedImages = [
  'household-finance-bot',
  'household-finance-document-preparer',
  'household-finance-actual-reader',
  'household-finance-actual-writer',
];

describe('container publishing workflow', () => {
  it('verifies pull requests and Actual latest compatibility without publishing', () => {
    expect(workflow).toMatch(/pull_request:\n\s+branches:\n\s+- main/);
    expect(workflow).toContain('run: bash scripts/verify-actual-compat.sh');
    expect(publish).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
  });

  it('publishes only commit-tagged matrix images before promotion', () => {
    expect(publishStart).toBeGreaterThan(0);
    expect(promoteStart).toBeGreaterThan(publishStart);
    expect(
      Array.from(
        publish.matchAll(/^\s+- image: (household-finance-[a-z-]+)$/gm),
        ([, image]) => image,
      ),
    ).toEqual(expectedImages);
    expect(publish).toContain(
      'tags: ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:${{ github.sha }}',
    );
    expect(publish).not.toContain(':latest');
  });

  it('gates one digest-based latest promotion on the complete matrix', () => {
    expect(promote).toMatch(/promote-latest:\n\s+needs: publish\n/);
    expect(promote).toContain('packages: write');
    expect(promote).not.toContain('contents: write');

    const imageArray = promote.match(/images=\(\n([\s\S]*?)\n\s+\)/)?.[1];
    expect(
      imageArray
        ?.trim()
        .split('\n')
        .map((line) => line.trim()),
    ).toEqual(expectedImages);

    const firstCreate = promote.indexOf('docker buildx imagetools create');
    expect(firstCreate).toBeGreaterThan(0);
    expect(promote.indexOf('for image in "${images[@]}"; do')).toBeLessThan(
      firstCreate,
    );
    expect(promote.slice(0, firstCreate)).toContain(
      'org.opencontainers.image.revision',
    );
    expect(promote.slice(0, firstCreate)).toContain(
      '.platform.architecture == "amd64"',
    );
    expect(promote).toContain('"${image_ref}@${digests[$index]}"');
    expect(promote.slice(firstCreate)).toContain(
      'if [[ "$latest_digest" != "${digests[$index]}" ]]',
    );
  });

  it('serializes tag writers and pins every action to a full commit', () => {
    expect(workflow).toContain('group: publish-images-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: false');
    const actionReferences = Array.from(
      workflow.matchAll(/^\s+uses: ([^\s]+)(?:\s+#.*)?$/gm),
      ([, reference]) => reference,
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

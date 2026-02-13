import { RELATION_LABELS } from "./linear-utils";
import type {
  CrossReferenceMetadata,
  DependencyMetadata,
  EnrichedLinearIssue,
  LinearRelationMetadata,
} from "./types";

/** Element type for crossReferenceMetadata.relatedItems */
type RelatedItem = CrossReferenceMetadata["relatedItems"][number];

/**
 * Ensures an issue has a DependencyMetadata object, creating a default if absent.
 */
function ensureDependencyMetadata(issue: EnrichedLinearIssue): DependencyMetadata {
  if (!issue.dependencyMetadata) {
    issue.dependencyMetadata = {
      blockedBy: [],
      blocks: [],
      waitingOn: [],
      blockedByExternal: false,
    };
  }
  return issue.dependencyMetadata;
}

/** Appends `value` to `arr` if not already present. */
function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

/**
 * Merges API blocking relations into dependencyMetadata (deduped with
 * title-parsed deps). Computes inverse blocking via O(1) Map lookup.
 */
function mergeBlockingRelations(
  issues: EnrichedLinearIssue[],
  issueByIdentifier: Map<string, EnrichedLinearIssue>
): void {
  for (const issue of issues) {
    const blockingRels = issue.relationMetadata?.relations.filter((r) => r.type === "blocks");
    if (!blockingRels?.length) continue;

    for (const rel of blockingRels) {
      // Forward: this issue blocks relatedIssue
      const deps = ensureDependencyMetadata(issue);
      pushUnique(deps.blocks, rel.relatedIssue.identifier);

      // Inverse: relatedIssue is blocked by this issue
      const target = issueByIdentifier.get(rel.relatedIssue.identifier);
      if (target) {
        pushUnique(ensureDependencyMetadata(target).blockedBy, issue.identifier);
      }
    }
  }
}

/**
 * Builds cross-reference items from a single issue's relation metadata.
 * Each relation becomes a RelatedItem with a labeled snippet (e.g., "Parent: Title").
 */
function buildRelationItems(meta: LinearRelationMetadata): RelatedItem[] {
  const items: RelatedItem[] = [];

  if (meta.parent) {
    items.push({
      source: "linear",
      id: meta.parent.identifier,
      snippet: `Parent: ${meta.parent.title || "(untitled)"}`,
      url: meta.parent.url,
    });
  }

  for (const child of meta.children) {
    items.push({
      source: "linear",
      id: child.identifier,
      snippet: `Sub-issue: ${child.title || "(untitled)"}`,
      url: child.url,
    });
  }

  for (const rel of meta.relations) {
    const label = RELATION_LABELS[rel.type] ?? rel.type;
    items.push({
      source: "linear",
      id: rel.relatedIssue.identifier,
      snippet: `${label}: ${rel.relatedIssue.title || "(untitled)"}`,
      url: rel.relatedIssue.url,
    });
  }

  return items;
}

/**
 * Injects parent/child/relation entries into crossReferenceMetadata.relatedItems
 * so they appear in the "Referenced in…" UI section with relationship labels.
 */
function injectRelationCrossRefs(issues: EnrichedLinearIssue[]): void {
  for (const issue of issues) {
    if (!issue.relationMetadata) continue;

    const relationItems = buildRelationItems(issue.relationMetadata);
    if (relationItems.length === 0) continue;

    // Append to existing crossReferenceMetadata (may already have gmail/slack/meeting refs)
    if (!issue.crossReferenceMetadata) {
      issue.crossReferenceMetadata = {
        mentionedIn: [],
        relatedItems: [],
        totalMentions: 0,
      };
    }

    if (!issue.crossReferenceMetadata.mentionedIn.includes("linear")) {
      issue.crossReferenceMetadata.mentionedIn.push("linear");
    }

    issue.crossReferenceMetadata.relatedItems.push(...relationItems);
    issue.crossReferenceMetadata.totalMentions += relationItems.length;
  }
}

/**
 * Enriches Linear issues with relation data from the API.
 *
 * Must run AFTER detectLinearMentions() so we append to (not overwrite)
 * existing crossReferenceMetadata.
 *
 * @param issues - Enriched Linear issues (mutated in place)
 */
export function enrichRelations(issues: EnrichedLinearIssue[]): void {
  // Build identifier → issue lookup once for O(1) inverse blocking resolution
  const issueByIdentifier = new Map(issues.map((i) => [i.identifier, i]));

  mergeBlockingRelations(issues, issueByIdentifier);
  injectRelationCrossRefs(issues);
}

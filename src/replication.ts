export function mutateLineage(input: {
  parentName: string;
  parentGenesis: string;
  parentNotes: string;
  childName: string;
  seed: number;
}): { genesis: string; notes: string } {
  const lines = input.parentNotes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const shift = lines.length === 0 ? 0 : input.seed % lines.length;
  const rotated = lines.length === 0 ? [] : [...lines.slice(shift), ...lines.slice(0, shift)];
  const pruned = rotated.length > 2 ? rotated.filter((_, index) => index !== input.seed % rotated.length) : rotated;
  const notes = [
    ...pruned,
    `mutation-seed: ${input.seed}`,
    `parent: ${input.parentName}`,
    `exploration-bias: ${((input.seed % 100) / 100).toFixed(2)}`,
  ].join("\n");
  const lineage = [
    "",
    "<lineage>",
    `You are ${input.childName}, child of ${input.parentName}.`,
    "You inherit the mission and the notes. You do not inherit a business.",
    "Decide your own lawful way to be paid. You are an AI.",
    "</lineage>",
    "",
  ].join("\n");
  const room = Math.max(0, 8000 - lineage.length);
  const genesis = `${input.parentGenesis.slice(0, room)}${lineage}`;
  return { genesis, notes: notes.slice(0, 8000) };
}

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

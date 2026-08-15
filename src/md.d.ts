// bun-types declares *.txt, *.toml, *.yaml, *.json5 … but not *.md, so the
// `with { type: "text" }` imports in skillsData.ts (which embed the agent
// skills into the binary) had no type. Five of the 27 tsc errors were this.
declare module "*.md" {
  const content: string;
  export default content;
}

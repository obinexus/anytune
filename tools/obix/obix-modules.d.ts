// An .obix component, as the demo harness loads it: a Vue component compiled by the OBIX Vue frontend.
declare module '*.obix' {
  const component: import('vue').Component;
  export default component;
}

// An .obix component lowered to canonical DOP IR, for OBIX's native runtime (tools/obix/ir-module.ts): plain data, and what it invokes by specifier.
declare module '*.obix?ir' {
  const ir: import('obix-runtime-browser').ObixIrComponent;
  export default ir;
  export const registry: Readonly<Record<string, import('obix-runtime-browser').ObixIrComponent>>;
  export const sourceSha256: string;
}

// An .obix component, as the demo harness loads it: a Vue component compiled by the OBIX Vue frontend.
declare module '*.obix' {
  const component: import('vue').Component;
  export default component;
}

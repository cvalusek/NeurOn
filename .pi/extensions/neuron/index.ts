// Thin pi extension loader. pi (0.74.2) autoloads this file from
// ~/.pi/agent/extensions/neuron/ and transpiles it on the fly with jiti.
// The actual adapter is the sibling esbuild bundle (neuron-pi.js) —
// core + adapter, zero runtime dependencies.
import neuron from "./neuron-pi.js";

export default neuron;

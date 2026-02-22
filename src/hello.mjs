/**
 * Returns a greeting for the given name.
 * @param {string} [name="World"]
 * @returns {string}
 */
export function greet(name = "World") {
  return `Hello, ${name}!`;
}

// Run directly: node src/hello.mjs [name]
const isMain = process.argv[1]?.endsWith("hello.mjs");
if (isMain) {
  const name = process.argv[2];
  console.log(greet(name));
}

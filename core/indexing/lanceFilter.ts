/** Quote a value for a LanceDB SQL filter. Embedded quotes are doubled. */
export function lanceStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function lanceDeleteFilter(cacheKey: string, path: string): string {
  return `cachekey = ${lanceStringLiteral(cacheKey)} AND path = ${lanceStringLiteral(path)}`;
}

export function lancePathPrefixFilter(directory: string): string {
  return `path LIKE ${lanceStringLiteral(`${directory}%`)}`;
}

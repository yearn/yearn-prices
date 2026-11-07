/** Adapt text-based database fixtures to the query-config and array-row protocol. */
export function driverQuery<F extends (...args: never[]) => unknown>(query: F): F {
  return new Proxy(query, {
    apply(target, thisArg, args) {
      const [config, values] = args
      if (typeof config === 'string') return Reflect.apply(target, thisArg, args)
      const text = config.text as string
      // Existing assertions compare SQL semantics independently of builder quoting.
      const fixtureText =
        config.rowMode === 'array' || /^(insert|update|delete)\b/.test(text) ? canonicalSql(text) : text
      const response = Reflect.apply(target, thisArg, [fixtureText, values ?? config.values])
      return Promise.resolve(response).then((result) => {
        if (config.rowMode !== 'array' || !result?.rows?.length || Array.isArray(result.rows[0])) return result
        const projection =
          /^select\s+(?:distinct on\s*\([^)]*\)\s*)?([\s\S]*?)\s+from\s/i.exec(text)?.[1] ??
          /\breturning\s+([\s\S]*)$/i.exec(text)?.[1]
        if (!projection) throw new Error('Array-mode fixture requires an explicit projection')
        const columns = projection.split(',').map((column) => {
          const name = /(?:"([^"]+)"|([\w]+))\s*$/.exec(column.trim())
          if (!name) throw new Error(`Unsupported fixture projection: ${column}`)
          return name[1] ?? name[2]
        })
        return {
          ...result,
          rows: result.rows.map((row: Record<string, unknown>) => columns.map((column) => row[column] ?? null))
        }
      })
    }
  })
}

function canonicalSql(text: string): string {
  return text
    .replace(/"([a-z_]+)"/g, '$1')
    .replace(
      /\b(select|distinct on|from|inner join|where|and|order by|insert into|values|on conflict|do nothing|do update set|returning|set|update|delete from)\b/gi,
      (keyword) => keyword.toUpperCase()
    )
    .replace(/,\s*/g, ', ')
}

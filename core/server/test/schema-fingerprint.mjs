import { createHash } from "node:crypto";

/**
 * The schema of an open database, as text: every table with its columns, and
 * every index, trigger and view by what it is made of. Columns are in the order
 * of their names, since a column that was added to an existing table comes after
 * the others and that is no difference to anything; a comment or the spacing of
 * a statement is none either.
 */
export function schemaText(d) {
  const normal = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const lines = [];
  for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    lines.push(`table ${name}`);
    const columns = d.pragma(`table_info(${name})`).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const c of columns) lines.push(`  ${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`);
  }
  for (const row of d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY type, name").all()) {
    lines.push(`${row.type} ${row.name} on ${row.tbl_name}: ${normal(row.sql)}`);
  }
  return lines.join("\n");
}

export const schemaFingerprint = (d) => createHash("sha256").update(schemaText(d)).digest("hex");

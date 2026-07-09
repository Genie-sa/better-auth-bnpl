import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

for (const file of process.argv.slice(2)) {
	const sourceText = await readFile(file, "utf8");
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
	const printer = ts.createPrinter({ removeComments: true });
	const output = `${printer.printFile(sourceFile)}\n`;
	await writeFile(file, output);
}

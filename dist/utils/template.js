// Trivial {{KEY}} → value templater. Used for systemd / launchd unit files.
import { promises as fs } from 'node:fs';
export async function renderTemplate(templatePath, vars) {
    const raw = await fs.readFile(templatePath, 'utf8');
    return raw.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
        if (!(key in vars)) {
            throw new Error(`template ${templatePath}: missing var {{${key}}}`);
        }
        return vars[key] ?? '';
    });
}
//# sourceMappingURL=template.js.map
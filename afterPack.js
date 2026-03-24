// afterPack.js
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
    if (context.electronPlatformName !== "linux") return;

    const appOutDir = context.appOutDir;

    // Buscar el ejecutable principal
    const exeName = context.packager.executableName;
    const exePath = path.join(appOutDir, exeName);

    if (!fs.existsSync(exePath)) return;

    // Renombrar el binario real
    const realBin = exePath + ".bin";
    fs.renameSync(exePath, realBin);

    // Crear wrapper script que inyecta --no-sandbox
    const wrapper = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/${exeName}.bin" --no-sandbox "$@"
`;
    fs.writeFileSync(exePath, wrapper, { mode: 0o755 });
};

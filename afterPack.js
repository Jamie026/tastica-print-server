const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
    if (context.electronPlatformName !== "linux") return;

    const appOutDir = context.appOutDir;
    const exeName = context.packager.executableName;
    const exePath = path.join(appOutDir, exeName);

    if (!fs.existsSync(exePath)) return;

    const realBin = exePath + ".bin";
    fs.renameSync(exePath, realBin);

    const wrapper =
        "#!/bin/bash\n" +
        'HERE="$(dirname "$(readlink -f "$0")")"\n' +
        'exec "$HERE/' +
        exeName +
        '.bin" --no-sandbox "$@"\n';

    fs.writeFileSync(exePath, wrapper, { mode: 0o755 });
};

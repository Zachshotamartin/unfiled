const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules")
];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const sourceBase = path.resolve(
      path.dirname(context.originModulePath),
      moduleName.slice(0, -3)
    );
    for (const extension of [".ts", ".tsx"]) {
      const candidate = `${sourceBase}${extension}`;
      if (fs.existsSync(candidate)) return { filePath: candidate, type: "sourceFile" };
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

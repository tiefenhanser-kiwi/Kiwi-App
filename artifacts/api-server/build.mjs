import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";
import { checkBundle, formatMissing } from "./bundleExternals.mjs";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the server bundle into distDir. Exported so bundleExternals.test.ts
 * can build into a temp dir with the SAME config and check it; the CLI path
 * at the bottom is what `pnpm build` and the Dockerfile run.
 */
export async function buildBundle(distDir = path.resolve(artifactDir, "dist")) {
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      // Row 5 Block 1c-fix — was "@google-cloud/*", which externalised
      // @google-cloud/storage too. The runtime stage of the repo-root
      // Dockerfile carries ONLY @prisma/client into the container, so the
      // hoisted `import ... from "@google-cloud/storage"` failed at boot
      // (ERR_MODULE_NOT_FOUND, revision kiwi-api-00010-fs2). Storage v8 is
      // REST-only (teeny-request + gaxios; @grpc/* is a devDependency) and
      // its one package.json read is a static relative require that esbuild
      // inlines — it bundles cleanly. The gax/gRPC-based clients are the ones
      // that path-traverse to sibling .proto files; list them explicitly.
      // Any NEW external that the code actually imports must ALSO be carried
      // by the Dockerfile — bundleExternals.mjs (beside this file, run after
      // every build below) fails the build if it is not.
      "@google-cloud/secret-manager",
      "@google-cloud/pubsub",
      "@google-cloud/firestore",
      "@google-cloud/spanner",
      "@google-cloud/bigtable",
      "@google-cloud/logging",
      "@google-cloud/tasks",
      "@google-cloud/scheduler",
      "google-gax",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  // Row 5 Block 1c-fix — every bare import left in the bundle must be a
  // package the repo-root Dockerfile carries into the runtime tree; a green
  // build with a missing one is a container that dies at boot.
  const bundlePath = path.join(distDir, "index.mjs");
  const { imports, missing } = checkBundle(bundlePath);
  if (missing.length > 0) throw new Error(formatMissing(bundlePath, missing));
  console.log(`bundle externals: ok — [${imports.map((i) => i.specifier).join(", ") || "none"}] all carried by the Dockerfile runtime tree`);
  return bundlePath;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  buildBundle().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

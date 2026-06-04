const path = require("path");
const webpack = require("webpack");
const dotenv = require("dotenv");
const cssExtract = require("mini-css-extract-plugin");
const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const packageJson = require("./package.json");
const dependencies = packageJson.dependencies;

const envPath = path.resolve(__dirname, ".env");
const envResult = dotenv.config({ path: envPath });
const envValues = {
  ...process.env,
  ...(envResult.error ? {} : envResult.parsed),
};

const defineEnv = {
  "process.env.ICVP_REGIONAL_BASE": JSON.stringify(envValues.ICVP_REGIONAL_BASE || ""),
  "process.env.ICVP_BASIC_USER": JSON.stringify(envValues.ICVP_BASIC_USER || ""),
  "process.env.ICVP_BASIC_PASS": JSON.stringify(envValues.ICVP_BASIC_PASS || ""),
  "process.env.ICVP_VHL_ISSUANCE_URL": JSON.stringify(envValues.ICVP_VHL_ISSUANCE_URL || ""),
  "process.env.ICVP_VHL_RESOLVE_URL": JSON.stringify(envValues.ICVP_VHL_RESOLVE_URL || ""),
  "process.env.ICVP_FROM_BUNDLE_URL": JSON.stringify(envValues.ICVP_FROM_BUNDLE_URL || ""),
  "process.env.ICVP_BASE": JSON.stringify(envValues.ICVP_BASE || ""),
  "process.env.IPS_REGIONAL_BASE": JSON.stringify(envValues.IPS_REGIONAL_BASE || ""),
  "process.env.IPS_BASIC_USER": JSON.stringify(envValues.IPS_BASIC_USER || ""),
  "process.env.IPS_BASIC_PASS": JSON.stringify(envValues.IPS_BASIC_PASS || ""),
  "process.env.IPS_VHL_ISSUANCE_URL": JSON.stringify(envValues.IPS_VHL_ISSUANCE_URL || ""),
  "process.env.IPS_VHL_RESOLVE_URL": JSON.stringify(envValues.IPS_VHL_RESOLVE_URL || ""),
  "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
};

module.exports = {
  resolve: {
    extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
    alias: {
      react: path.resolve(__dirname, "./src/__mocks__/globalReact.js"),
      "react-dom": path.resolve(__dirname, "./src/__mocks__/globalReactDom.js"),
    },
  },
  entry: {
    ipd: "./src/ipd/index.js",
    "next-ui": "./src/next-ui/index.js",
    shared: "./src/shared.js",
  },
  output: {
    path: path.resolve(__dirname, "../ui/app/micro-frontends-dist"),
    filename: "[name].min.js",
    clean: true,
  },
  devServer: {},
  plugins: [
    new cssExtract({
      filename: "[name].min.css",
    }),
    new webpack.DefinePlugin(defineEnv),
    new CopyWebpackPlugin({
      patterns: [{ from: "public", to: "../micro-frontends-dist/" }],
    }),
    new ModuleFederationPlugin({
      name: "bahmni_mfe_host",
      filename: "remoteEntry.js",
      remotes: {
        "@openmrs-mf/ipd": remoteProxiedAtHostDomain({ name: "bahmni_ipd", path: "ipd" }),
      },
      exposes: {},
      shared: {
        "carbon-components-react": {
          singleton: true,
          eager: true,
          requiredVersion: dependencies["carbon-components-react"],
        },
        "carbon-components": {
          singleton: true,
          eager: true,
          requiredVersion: dependencies["carbon-components"],
        },
        "bahmni-carbon-ui": {
          singleton: true,
          eager: true,
          requiredVersion: dependencies["bahmni-carbon-ui"],
        },
        react: {
          singleton: true,
          eager: true,
          requiredVersion: dependencies.react,
        },
        "react-dom": {
          singleton: true,
          eager: true,
          requiredVersion: dependencies["react-dom"],
        },
      },
    }),
  ],
  module: {
    // noParse: ['react'],
    rules: [
      {
        test: /\.m?js/,
        type: "javascript/auto",
        resolve: {
          fullySpecified: false,
        },
      },
      {
        test: /\.(ts|tsx|js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
        },
      },
      {
        test: /\.css$/i,
        use: [cssExtract.loader, "css-loader"],
      },
      {
        test: /\.s[ac]ss$/i,
        use: [cssExtract.loader, "css-loader", "sass-loader"],
      },
    ],
  },
  externals: {
    react: "React", // Exclude react from the bundled output
    "react-dom": "ReactDOM", // Exclude react-dom from the bundled output
  },
};

/**
 * An alternative to providing build time URLs
 * We need to do this string promise stuff because we need to resolve the host at run-time.
 * This is the way, as documented here: https://webpack.js.org/concepts/module-federation/#promise-based-dynamic-remotes
 *
 * @param {string} name The name of the remote, as given in it's ModuleFederationPlugin configuration
 * @param {string} subPath The sub-path of the remote, as set-up in the proxy configuration
 *
 * @returns {string} A string that can be evaluated to a promise that resolves to the remote
 */
function remoteProxiedAtHostDomain({name, path}) {
  return `promise new Promise(resolve => {
    const remoteUrl = new URL(window.location.href);
    remoteUrl.pathname = '/${path}/remoteEntry.js';
    remoteUrl.search = '';

    const script = document.createElement('script')
    script.src = remoteUrl.toString();
    script.onload = () => {
      // the injected script has loaded and is available on window
      // we can now resolve this Promise
      const proxy = {
        get: (request) => window['${name}'].get(request),
        init: (arg) => {
          try {
            return window['${name}'].init(arg)
          } catch(e) {
            console.log('remote container already initialized')
          }
        }
      }
      resolve(proxy)
    }
    // inject this script with the src set to the resolved remoteEntry.js
    document.head.appendChild(script);
  })`;
}

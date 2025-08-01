/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AnyRouteRefParams,
  BackstagePlugin as LegacyBackstagePlugin,
  RouteRef,
  createPlugin,
  getComponentData,
} from '@backstage/core-plugin-api';
import {
  FrontendPlugin,
  ExtensionDefinition,
  coreExtensionData,
  createExtension,
  createExtensionInput,
  createFrontendPlugin,
  ApiBlueprint,
  PageBlueprint,
  FrontendModule,
  createFrontendModule,
} from '@backstage/frontend-plugin-api';
import { Children, ReactNode, isValidElement } from 'react';
import { Route, Routes } from 'react-router-dom';
import {
  convertLegacyRouteRef,
  convertLegacyRouteRefs,
} from './convertLegacyRouteRef';
import { compatWrapper } from './compatWrapper';
import { collectEntityPageContents } from './collectEntityPageContents';
import { normalizeRoutePath } from './normalizeRoutePath';

/*

# Legacy interoperability

Use-cases (prioritized):
 1. Slowly migrate over an existing app to DI, piece by piece
 2. Use a legacy plugin in a new DI app
 3. Use DI in an existing legacy app

Starting point: use-case #1

Potential solutions:
 1. Codemods (we're not considering this for now)
 2. Legacy apps are migrated bottom-up, i.e. keep legacy root, replace pages with DI
 3. Legacy apps are migrated top-down i.e. switch out base to DI, legacy adapter allows for usage of existing app structure

Chosen path: #3

Existing tasks:
  - Adopters can migrate their existing app gradually (~4)
    - Example-app uses legacy base with DI adapters
    - Create an API that lets you inject DI into existing apps - working assumption is that this is enough
  - Adopters can use legacy plugins in DI through adapters (~8)
    - App-next uses DI base with legacy adapters
    - Create a legacy adapter that is able to take an existing extension tree

*/

// Creates a shim extension whose purpose is to build up the tree (anchored at
// the root page) of paths/routeRefs so that the app can bind them properly.
function makeRoutingShimExtension(options: {
  name: string;
  parentExtensionId: string;
  routePath?: string;
  routeRef?: RouteRef;
}) {
  const { name, parentExtensionId, routePath, routeRef } = options;
  return createExtension({
    kind: 'routing-shim',
    name,
    attachTo: { id: parentExtensionId, input: 'childRoutingShims' },
    inputs: {
      childRoutingShims: createExtensionInput([
        coreExtensionData.routePath.optional(),
        coreExtensionData.routeRef.optional(),
      ]),
    },
    output: [
      coreExtensionData.routePath.optional(),
      coreExtensionData.routeRef.optional(),
    ],
    *factory() {
      if (routePath !== undefined) {
        yield coreExtensionData.routePath(routePath);
      }

      if (routeRef) {
        yield coreExtensionData.routeRef(convertLegacyRouteRef(routeRef));
      }
    },
  });
}

export function visitRouteChildren(options: {
  children: ReactNode;
  parentExtensionId: string;
  context: {
    pluginId: string;
    extensions: ExtensionDefinition[];
    getUniqueName: () => string;
    discoverPlugin: (plugin: LegacyBackstagePlugin) => void;
  };
}): void {
  const { children, parentExtensionId, context } = options;
  const { pluginId, extensions, getUniqueName, discoverPlugin } = context;

  Children.forEach(children, node => {
    if (!isValidElement(node)) {
      return;
    }

    const plugin = getComponentData<LegacyBackstagePlugin>(node, 'core.plugin');
    const routeRef = getComponentData<RouteRef<AnyRouteRefParams>>(
      node,
      'core.mountPoint',
    );
    const routePath: string | undefined = node.props?.path;

    if (plugin) {
      // We just mark the plugin as discovered, but don't change the context
      discoverPlugin(plugin);
    }

    let nextParentExtensionId = parentExtensionId;
    if (routeRef || routePath) {
      const nextParentExtensionName = getUniqueName();
      nextParentExtensionId = `routing-shim:${pluginId}/${nextParentExtensionName}`;
      extensions.push(
        makeRoutingShimExtension({
          name: nextParentExtensionName,
          parentExtensionId,
          routePath,
          routeRef,
        }),
      );
    }

    visitRouteChildren({
      children: node.props.children,
      parentExtensionId: nextParentExtensionId,
      context,
    });
  });
}

/** @internal */
export function collectLegacyRoutes(
  flatRoutesElement: JSX.Element,
  entityPage?: JSX.Element,
): (FrontendPlugin | FrontendModule)[] {
  const output = new Array<FrontendPlugin | FrontendModule>();

  const pluginExtensions = new Map<
    LegacyBackstagePlugin,
    ExtensionDefinition[]
  >();

  const getUniqueName = (() => {
    let currentIndex = 1;
    return () => String(currentIndex++);
  })();

  // Placeholder plugin for any routes that don't belong to a plugin
  const orphanRoutesPlugin = createPlugin({ id: 'converted-orphan-routes' });

  const getPluginExtensions = (plugin: LegacyBackstagePlugin) => {
    let extensions = pluginExtensions.get(plugin);
    if (!extensions) {
      extensions = [];
      pluginExtensions.set(plugin, extensions);
    }
    return extensions;
  };

  Children.forEach(flatRoutesElement.props.children, (route: ReactNode) => {
    if (route === null) {
      return;
    }
    // TODO(freben): Handle feature flag and permissions framework wrapper elements
    if (!isValidElement(route)) {
      throw new Error(
        `Invalid element inside FlatRoutes, expected Route but found element of type ${typeof route}.`,
      );
    }
    if (route.type !== Route) {
      throw new Error(
        `Invalid element inside FlatRoutes, expected Route but found ${route.type}.`,
      );
    }
    const routeElement = route.props.element;
    const path: string | undefined = route.props.path;
    const plugin =
      getComponentData<LegacyBackstagePlugin>(routeElement, 'core.plugin') ??
      orphanRoutesPlugin;
    const routeRef = getComponentData<RouteRef>(
      routeElement,
      'core.mountPoint',
    );
    if (path === undefined) {
      throw new Error(
        `Route element inside FlatRoutes had no path prop value given`,
      );
    }

    const extensions = getPluginExtensions(plugin);
    const pageExtensionName = extensions.length ? getUniqueName() : undefined;
    const pageExtensionId = `page:${plugin.getId()}${
      pageExtensionName ? `/${pageExtensionName}` : pageExtensionName
    }`;

    extensions.push(
      PageBlueprint.makeWithOverrides({
        name: pageExtensionName,
        inputs: {
          childRoutingShims: createExtensionInput([
            coreExtensionData.routePath.optional(),
            coreExtensionData.routeRef.optional(),
          ]),
        },
        factory(originalFactory, { inputs: _inputs }) {
          // todo(blam): why do we not use the inputs here?
          return originalFactory({
            defaultPath: normalizeRoutePath(path),
            routeRef: routeRef ? convertLegacyRouteRef(routeRef) : undefined,
            loader: async () =>
              compatWrapper(
                route.props.children ? (
                  <Routes>
                    <Route path="*" element={routeElement}>
                      <Route path="*" element={route.props.children} />
                    </Route>
                  </Routes>
                ) : (
                  routeElement
                ),
              ),
          });
        },
      }),
    );

    visitRouteChildren({
      children: route.props.children,
      parentExtensionId: pageExtensionId,
      context: {
        pluginId: plugin.getId(),
        extensions,
        getUniqueName,
        discoverPlugin: getPluginExtensions,
      },
    });
  });

  if (entityPage) {
    collectEntityPageContents(entityPage, {
      discoverExtension(extension, plugin) {
        if (!plugin || plugin.getId() === 'catalog') {
          getPluginExtensions(orphanRoutesPlugin).push(extension);
        } else {
          getPluginExtensions(plugin).push(extension);
        }
      },
    });

    const extensions = new Array<ExtensionDefinition>();
    visitRouteChildren({
      children: entityPage,
      parentExtensionId: `page:catalog/entity`,
      context: {
        pluginId: 'catalog',
        extensions,
        getUniqueName,
        discoverPlugin(plugin) {
          if (plugin.getId() !== 'catalog') {
            getPluginExtensions(plugin);
          }
        },
      },
    });

    output.push(
      createFrontendModule({
        pluginId: 'catalog',
        extensions,
      }),
    );
  }

  for (const [plugin, extensions] of pluginExtensions) {
    output.push(
      createFrontendPlugin({
        pluginId: plugin.getId(),
        extensions: [
          ...extensions,
          ...Array.from(plugin.getApis()).map(factory =>
            ApiBlueprint.make({
              name: factory.api.id,
              params: define => define(factory),
            }),
          ),
        ],
        routes: convertLegacyRouteRefs(plugin.routes ?? {}),
        externalRoutes: convertLegacyRouteRefs(plugin.externalRoutes ?? {}),
      }),
    );
  }

  return output;
}

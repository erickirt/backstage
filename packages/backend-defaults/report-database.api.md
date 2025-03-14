## API Report File for "@backstage/backend-defaults"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts
import { DatabaseService } from '@backstage/backend-plugin-api';
import { LifecycleService } from '@backstage/backend-plugin-api';
import { LoggerService } from '@backstage/backend-plugin-api';
import { RootConfigService } from '@backstage/backend-plugin-api';
import { RootLifecycleService } from '@backstage/backend-plugin-api';
import { RootLoggerService } from '@backstage/backend-plugin-api';
import { ServiceFactory } from '@backstage/backend-plugin-api';

// @public
export class DatabaseManager {
  forPlugin(
    pluginId: string,
    deps: {
      logger: LoggerService;
      lifecycle: LifecycleService;
    },
  ): DatabaseService;
  static fromConfig(
    config: RootConfigService,
    options?: DatabaseManagerOptions,
  ): DatabaseManager;
}

// @public
export type DatabaseManagerOptions = {
  migrations?: DatabaseService['migrations'];
  rootLogger?: RootLoggerService;
  rootLifecycle?: RootLifecycleService;
};

// @public
export const databaseServiceFactory: ServiceFactory<
  DatabaseService,
  'plugin',
  'singleton'
>;

// (No @packageDocumentation comment for this package)
```

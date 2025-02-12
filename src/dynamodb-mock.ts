import type {
  DynamoDBDocument,
  QueryCommandInput,
  UpdateCommandInput,
  GetCommandInput,
  DeleteCommandInput,
  PutCommandInput,
  BatchWriteCommandInput,
  QueryCommandOutput,
  UpdateCommandOutput,
  GetCommandOutput,
  DeleteCommandOutput,
  PutCommandOutput,
  BatchWriteCommandOutput,
  DynamoDBDocumentClientResolvedConfig,
  BatchGetCommandOutput,
  BatchGetCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { M } from "vitest/dist/chunks/environment.d8YfPkTm";

type Item = Record<string, any>;
type IndexDefinitions = {
  [tableName: string]: {
    [indexName: string]: {
      hashKey: string;
      rangeKey?: string;
    };
  };
};

type Operator = "=" | "<" | ">" | "<=" | ">=" | "BETWEEN" | "begins_with";
type Condition = {
  attr: string;
  op: Operator;
  param: string;
};

const resolveAttributeName = (
  attr: string,
  expressionAttributeNames?: Record<string, string>,
): string => {
  if (attr.startsWith("#")) {
    if (!expressionAttributeNames || !(attr in expressionAttributeNames)) {
      throw new Error(`ExpressionAttributeNames missing entry for ${attr}`);
    }
    return expressionAttributeNames[attr];
  }
  return attr;
};

const parseCondition = (
  expression: string,
  expressionAttributeNames?: Record<string, string>,
): Condition[] => {
  if (!expression?.trim())
    throw new Error("KeyConditionExpression is required");

  const conditions: Condition[] = [];
  let remaining = expression;

  while (remaining) {
    const betweenMatch = remaining.match(
      /(\w+)\s+(BETWEEN|between)\s+(\S+)\s+(AND|and)\s+(\S+)/,
    );
    if (betweenMatch) {
      const [full, attr, _, start, __, end] = betweenMatch;
      conditions.push({
        attr: resolveAttributeName(attr, expressionAttributeNames),
        op: "BETWEEN",
        param: `${start} AND ${end}`,
      });
      remaining = remaining.replace(full, "").replace(/^\s*AND|and\s*/, "");
      continue;
    }

    const funcMatch = remaining.match(/(\w+)\(([^,]+),\s*([^)]+)\)/);
    if (funcMatch) {
      const [full, op, attr, param] = funcMatch;
      conditions.push({
        attr: attr.trim(),
        op: op as Operator,
        param: param.trim(),
      });
      remaining = remaining.replace(full, "").replace(/^\s*(AND|and)\s*/, "");
      continue;
    }

    const stdMatch = remaining.match(/#?(\w+)\s*(=|<=|>=|<|>)\s*(\S+)/);
    if (stdMatch) {
      const [full, attr, op, param] = stdMatch;
      conditions.push({
        attr: resolveAttributeName(attr.trim(), expressionAttributeNames),
        op: op as Operator,
        param: param.trim(),
      });
      remaining = remaining.replace(full, "").replace(/^\s*(AND|and)\s*/, "");
      continue;
    }

    if (remaining.trim()) throw new Error(`Invalid condition: ${remaining}`);
    break;
  }

  return conditions;
};

/**
 * Mock DynamoDB implementation for TESTING ONLY
 */
export class DynamoDBMock implements DynamoDBDocument {
  private tables: {
    [tableName: string]: {
      primary: Map<string, Item[]>;
      indexes: {
        [indexName: string]: Map<string, Item[]>;
      };
    };
  } = {};
  private readonly indexDefinitions: IndexDefinitions = {};

  config: DynamoDBDocumentClientResolvedConfig =
    {} as DynamoDBDocumentClientResolvedConfig;
  middlewareStack = {} as any;

  constructor(indexDefinitions: IndexDefinitions) {
    this.indexDefinitions = indexDefinitions;
    this.setupTables();
  }

  private setupTables() {
Object.keys(this.indexDefinitions).forEach((tableName) => {
      this.tables[tableName] = {
        primary: new Map(),
        indexes: Object.keys(this.indexDefinitions[tableName]).reduce(
          (acc, indexName) => {
            acc[indexName] = new Map();
            return acc;
          },
          {} as Record<string, Map<string, Item[]>>,
        ),
      };
    });
  }

  private updateIndexes(tableName: string, item: Item) {
    const tableIndexes = this.indexDefinitions[tableName];
    if (!tableIndexes) return;

    Object.entries(tableIndexes).forEach(([indexName, { hashKey }]) => {
      const indexMap = this.tables[tableName].indexes[indexName];
      const hashKeyValue = item[hashKey];

      let items = indexMap.get(hashKeyValue) || [];
      const existingIndex = items.findIndex(
        (i) => i.pk === item.pk && i.sk === item.sk,
      );

      if (existingIndex !== -1) {
        items[existingIndex] = item;
      } else {
        items = [...items, item];
      }

      indexMap.set(hashKeyValue, items);
    });
  }

  private removeFromIndexes(tableName: string, item: Item) {
    const tableIndexes = this.indexDefinitions[tableName];
    if (!tableIndexes) return;

    Object.entries(tableIndexes).forEach(([indexName, { hashKey }]) => {
      const indexMap = this.tables[tableName].indexes[indexName];
      const hashKeyValue = item[hashKey];

      const items = indexMap.get(hashKeyValue);
      if (!items) return;

      const filteredItems = items.filter(
        (i) => !(i.pk === item.pk && i.sk === item.sk),
      );

      if (filteredItems.length === 0) {
        indexMap.delete(hashKeyValue);
      } else {
        indexMap.set(hashKeyValue, filteredItems);
      }
    });
  }

  async put(input: PutCommandInput): Promise<PutCommandOutput> {
    const { TableName, Item } = input;
    if (TableName === undefined)
      throw new Error("TableName is a required argument");
    if (Item === undefined) throw new Error("Item is a required argument");
    if (!Item.pk) throw new Error("Item.pk is a required argument");
    if (!Item.sk) throw new Error("Item.sk is a required argument");

    const table = this.tables[TableName].primary;

    const items = table.get(Item.pk) || [];
    const existingIndex = items.findIndex((i) => i.sk === Item.sk);

    // Remove from indexes if updating
    if (existingIndex !== -1) {
      this.removeFromIndexes(TableName, items[existingIndex]);
    }

    // Update primary storage
    if (existingIndex !== -1) {
      items[existingIndex] = Item;
    } else {
      items.push(Item);
    }
    table.set(Item.pk, items);

    // Update indexes
    this.updateIndexes(TableName, Item);

    return {
      $metadata: {},
      Attributes: Item,
    };
  }

  async query(input: QueryCommandInput): Promise<QueryCommandOutput> {
    const {
      TableName,
      IndexName,
      KeyConditionExpression,
      ExpressionAttributeValues,
      ExpressionAttributeNames,
      ScanIndexForward = true,
    } = input;
    if (TableName === undefined)
      throw new Error("TableName is a required argument");

    const conditions = parseCondition(
      KeyConditionExpression!,
      ExpressionAttributeNames,
    );

    let results: Item[] = [];

    if (IndexName) {
      const indexDef = this.indexDefinitions[TableName]?.[IndexName];
      if (!indexDef) {
        throw new Error(`Index ${IndexName} not found on table ${TableName}`);
      }

      const hashKeyCondition = conditions.find(
        (c) =>
          resolveAttributeName(c.attr) === indexDef.hashKey && c.op === "=",
      );
      if (!hashKeyCondition) {
        throw new Error(
          `Query must use hash key ${indexDef.hashKey} with equals condition`,
        );
      }

      const hashKeyValue = ExpressionAttributeValues![hashKeyCondition.param];
      const indexMap = this.tables[TableName].indexes[IndexName];
      results = indexMap.get(hashKeyValue) || [];
    } else {
      const pkCondition = conditions.find(
        (c) => resolveAttributeName(c.attr) === "pk" && c.op === "=",
      );
      if (pkCondition) {
        const pk = ExpressionAttributeValues![pkCondition.param];
        results = this.tables[TableName].primary.get(pk) || [];
      } else {
        results = Array.from(this.tables[TableName].primary.values()).flat();
      }
    }

    // Apply remaining conditions
    results = results.filter((item) => {
      return conditions.every(({ attr, op, param }) => {
        const resolvedAttr = resolveAttributeName(attr);

        if (
          op === "=" &&
          resolvedAttr ===
            (IndexName
              ? this.indexDefinitions[TableName][IndexName].hashKey
              : "pk")
        ) {
          return true; // Already filtered by Map key
        }

        const value = ExpressionAttributeValues![param!];
        switch (op) {
          case "=":
            return item[resolvedAttr] === value;
          case ">":
            return item[resolvedAttr] > value;
          case "<":
            return item[resolvedAttr] < value;
          case "BETWEEN":
            const [start, end] = param.split(" AND ");
            return (
              item[resolvedAttr] >= ExpressionAttributeValues![start] &&
              item[resolvedAttr] <= ExpressionAttributeValues![end]
            );
          case "begins_with":
            return item[resolvedAttr].startsWith(value);
          default:
            return false;
        }
      });
    });

    if (IndexName && this.indexDefinitions[TableName][IndexName].rangeKey) {
      const rangeKey = this.indexDefinitions[TableName][IndexName].rangeKey!;
      results.sort((a, b) => a[rangeKey].localeCompare(b[rangeKey]));
    } else {
      results.sort((a, b) => a.sk.localeCompare(b.sk));
    }
    if (!ScanIndexForward) {
      results.reverse();
    }

    if (input.Limit) {
      results = results.slice(0, input.Limit);
    }

    return {
      $metadata: {},
      Items: results,
      Count: results.length,
      ScannedCount: results.length,
    };
  }

  // GET implementation
  async get(input: GetCommandInput): Promise<GetCommandOutput> {
    const { TableName, Key } = input;
    if (!TableName) throw new Error("TableName is a required argument");
    if (!Key) throw new Error("Key is a required argument");
    if (!Key.pk) throw new Error("Key.pk is a required argument");

    const table = this.tables[TableName].primary;
    const items = table.get(Key.pk) || [];
    const item = items.find((i) => i.sk === Key.sk);

    if (!item) {
      return {
        $metadata: {},
      };
    }

    return {
      $metadata: {},
      Item: item,
    };
  }

  async update(input: UpdateCommandInput): Promise<UpdateCommandOutput> {
    const {
      TableName,
      Key,
      UpdateExpression,
      ExpressionAttributeValues,
      ExpressionAttributeNames,
    } = input;
    if (!TableName) throw new Error("TableName is a required argument");
    if (!Key) throw new Error("Key is a required argument");
    if (!UpdateExpression)
      throw new Error("UpdateExpression is a required argument");

    const table = this.tables[TableName].primary;
    const items = table.get(Key.pk) || [];
    const itemIndex = items.findIndex((i) => i.sk === Key.sk);

    if (itemIndex === -1) {
      throw new Error("Item not found");
    }

    const item = { ...items[itemIndex] };

    // Parse update expression (supporting only SET operations for simplicity)
    const setParts = UpdateExpression.replace("SET ", "").split(", ");
    setParts.forEach((part) => {
      const [path, value] = part.split(" = ");
      const pathName = resolveAttributeName(
        path.trim(),
        ExpressionAttributeNames,
      );
      if (value.startsWith(":")) {
        item[pathName] = ExpressionAttributeValues![value];
      }
    });

    // Remove from indexes before updating
    this.removeFromIndexes(TableName, items[itemIndex]);

    // Update primary storage
    items[itemIndex] = item;
    table.set(Key.pk, items);

    // Update indexes
    this.updateIndexes(TableName, item);

    return {
      $metadata: {},
      Attributes: item,
    };
  }

  async delete(input: DeleteCommandInput): Promise<DeleteCommandOutput> {
    const { TableName, Key } = input;
    if (!TableName) throw new Error("TableName is a required argument");
    if (!Key) throw new Error("Key is a required argument");

    const table = this.tables[TableName].primary;
    const items = table.get(Key.pk) || [];
    const itemIndex = items.findIndex((i) => i.sk === Key.sk);

    if (itemIndex === -1) {
      return {
        $metadata: {},
      };
    }
    const item = items[itemIndex];

    // Remove from indexes
    this.removeFromIndexes(TableName, items[itemIndex]);

    // Remove from primary storage
    items.splice(itemIndex, 1);
    if (items.length === 0) {
      table.delete(Key.pk);
    } else {
      table.set(Key.pk, items);
    }

    return {
      $metadata: {},
      Attributes: item,
    };
  }

  async batchGet(input: BatchGetCommandInput): Promise<BatchGetCommandOutput> {
    if (!input.RequestItems) {
      return {
        $metadata: {},
        Responses: {},
        UnprocessedKeys: {},
      };
    }
    const responses: { [tableName: string]: Item[] } = {};

    for (const [tableName, { Keys }] of Object.entries(input.RequestItems)) {
      const table = this.tables[tableName].primary;
      const items: Item[] = [];

      if (Keys) {
        for (const key of Keys) {
          if (!key) continue;
          const tableItems = table.get(key.pk as unknown as string) || [];
          const item = tableItems.find((i) => i.sk === key.sk);
          if (item) {
            items.push(item);
          }
        }
      }

      responses[tableName] = items;
    }

    return {
      Responses: responses,
      UnprocessedKeys: {},
      $metadata: {},
    };
  }

  async batchWrite(
    input: BatchWriteCommandInput,
  ): Promise<BatchWriteCommandOutput> {
    if (!input.RequestItems) {
      return {
        $metadata: {},
        UnprocessedItems: {},
      };
    }

    for (const [tableName, requests] of Object.entries(input.RequestItems)) {
      for (const request of requests) {
        if (request.PutRequest) {
          await this.put({
            TableName: tableName,
            Item: request.PutRequest.Item,
          });
        } else if (request.DeleteRequest) {
          await this.delete({
            TableName: tableName,
            Key: request.DeleteRequest.Key,
          });
        }
      }
    }

    return {
      $metadata: {},
      UnprocessedItems: {},
    };
  }
  // Unimplemented methods
  async scan(): Promise<never> {
    throw new Error("Method not implemented: scan");
  }
  async transactGet(): Promise<never> {
    throw new Error("Method not implemented: transactGet");
  }
  async transactWrite(): Promise<never> {
    throw new Error("Method not implemented: transactWrite");
  }

  async send(command: any): Promise<any> {
    const commandName = command.constructor.name;
    switch (commandName) {
      case 'GetCommand':
        return this.get(command.input);
      case 'PutCommand':
        return this.put(command.input);
      case 'QueryCommand':
        return this.query(command.input);
      case 'UpdateCommand':
        return this.update(command.input);
      case 'DeleteCommand':
        return this.delete(command.input);
      case 'BatchGetCommand':
        return this.batchGet(command.input);
      case 'BatchWriteCommand':
        return this.batchWrite(command.input);
      case 'ScanCommand':
        return this.scan();
      case 'TransactGetCommand':
        return this.transactGet();
      case 'TransactWriteCommand':
        return this.transactWrite();
      case 'ExecuteStatementCommand':
        return this.executeStatement();
      case 'ExecuteTransactionCommand':
        return this.executeTransaction();
      case 'BatchExecuteStatementCommand':
        return this.batchExecuteStatement();
      default:
        throw new Error(`Command not implemented: ${commandName}`);
    }
  }
  async destroy(): Promise<never> {
    throw new Error("Method not implemented: destroy");
  }
  async batchExecuteStatement(): Promise<never> {
    throw new Error("Method not implemented: batchExecuteStatement");
  }
  async executeStatement(): Promise<never> {
    throw new Error("Method not implemented: executeStatement");
  }
  async executeTransaction(): Promise<never> {
    throw new Error("Method not implemented: executeTransaction");
  }

  // Internal testing methods
  getTable(tableName: string): Map<string, Item[]> {
    return this.tables[tableName].primary;
  }

  clearAll() {
    this.setupTables();
  }
}

# DynamoDB Mock

## Overview
DynamoDB Mock is a simple and easy-to-use in memory implementation of DynamoDB for testing. It has an Interface compatible with the [DynamoDB Document Client](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html).

## Installation
```bash
npm install dynamodb-mock
```

```bash
pnpm install dynamodb-mock
```

## Usage

```ts
import { DynamoDBMock } from "dynamodb-mock";

const db = new DynamoDBMock();

// Use the db as a DynamoDB Document Client
const result = await db.send(
    new GetCommand({ TableName: "my-table", Key: { id: "1" } })
);
```

## Limitations
It does not support all of the DynamoDB Document Client operations.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

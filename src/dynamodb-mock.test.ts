import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDBMock } from "./dynamodb-mock";

const TableName = "table";

const user1 = {
  pk: "user#1",
  sk: "profile",
  gsi1pk: "status#active",
  gsi1sk: "user#1",
  name: "John Doe",
};
const user2 = {
  pk: "user#2",
  sk: "profile",
  gsi1pk: "status#active",
  gsi1sk: "user#2",
  name: "Jane",
};

describe("DynamoDBMock", () => {
  let db: DynamoDBMock;

  const indexDefinitions = {
    [TableName]: {
      gsi1: {
        hashKey: "gsi1pk",
        rangeKey: "gsi1sk",
      },
    },
  };

  beforeEach(() => {
    db = new DynamoDBMock(indexDefinitions);
  });

  describe("put operations", () => {
    it("should successfully put an item", async () => {
      const item = {
        pk: "user#1",
        sk: "profile",
        name: "John Doe",
      };

      const result = await db.put({
        TableName,
        Item: item,
      });
      expect(result.$metadata).toBeDefined();
      expect(result.Attributes).toEqual(item);

      const getResult = await db.get({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });
      expect(getResult.Item).toEqual(item);
    });

    it("should successfully put an item with indexes", async () => {
      const result = await db.put({
        TableName,
        Item: user1,
      });
      expect(result.$metadata).toBeDefined();
      expect(result.Attributes).toEqual(user1);

      const getResult = await db.get({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });
      expect(getResult.Item).toEqual(user1);

      const queryResult = await db.query({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :status and gsi1sk = :user",
        ExpressionAttributeValues: {
          ":status": "status#active",
          ":user": "user#1",
        },
      });
      expect(queryResult.Items).toEqual([user1]);
    });

    it("should throw error when required fields are missing", async () => {
      await expect(
        db.put({
          TableName,
          Item: { pk: "user#1" }, // missing sk
        }),
      ).rejects.toThrow();
    });

    it("should update existing item", async () => {
      await db.put({ TableName, Item: user1 });

      const updatedItem = { ...user1, name: "Jane Doe" };
      await db.put({ TableName, Item: updatedItem });

      const getResult = await db.get({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });
      expect(getResult.Item).toEqual(updatedItem);
    });
  });

  describe("get operations", () => {
    it("should return item when it exists", async () => {
      const item = user1;

      await db.put({ TableName, Item: item });

      const result = await db.get({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });

      expect(result.Item).toEqual(item);
    });

    it("should return empty when item does not exist", async () => {
      const result = await db.get({
        TableName,
        Key: { pk: "nonexistent", sk: "profile" },
      });

      expect(result.Item).toBeUndefined();
    });
  });

  describe("query operations", () => {
    beforeEach(async () => {
      // Set up test data
      const items = [
        user1,
        user2,
        {
          pk: "user#1",
          sk: "extra",
        },
      ];

      for (const item of items) {
        await db.put({ TableName, Item: item });
      }
    });

    it("should query by primary key", async () => {
      const result = await db.query({
        TableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "user#1" },
      });

      expect(result.Items).toHaveLength(2);
      expect(result.Items![1].name).toBe("John Doe");
    });

    it("should query by GSI", async () => {
      const result = await db.query({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :status",
        ExpressionAttributeValues: { ":status": "status#active" },
      });

      expect(result.Items).toHaveLength(2);
    });

    it("should query items in reverse order", async () => {
      const result = await db.query({
        TableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "user#1" },
        ScanIndexForward: false,
      });

      expect(result.Items).toHaveLength(2);
      expect(result.Items![0].name).toBe("John Doe");
    });

    it("should query items with limit", async () => {
      const result = await db.query({
        TableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "user#1" },
        Limit: 1,
      });

      expect(result.Items).toHaveLength(1);
    });

    it("should query items using begins_with", async () => {
      const result = await db.query({
        TableName,
        KeyConditionExpression: "begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":prefix": "ex" },
      });

      expect(result.Items).toHaveLength(1);
      expect(result.Items![0].sk).toBe("extra");
    });

    it("should query items with between condition", async () => {
      const result = await db.query({
        TableName,
        KeyConditionExpression: "sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":start": "profile",
          ":end": "z",
        },
      });

      expect(result.Items).toHaveLength(2);
      expect(result.Items![0].sk).toBe("profile");
      expect(result.Items![1].sk).toBe("profile");
    });

    it("should query items with cutom ExperssionAttributeNames", async () => {
      const result = await db.query({
        TableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": "user#1" },
      });

      expect(result.Items).toHaveLength(2);
    });
  });

  describe("update operations", () => {
    it("should update existing item", async () => {
      await db.put({ TableName, Item: user1 });

      await db.update({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
        UpdateExpression: "SET #n = :name",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":name": "Johny" },
      });

      const result = await db.get({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });

      expect(result.Item!.name).toBe("Johny");
    });

    it("should throw error when item does not exist", async () => {
      await expect(
        db.update({
          TableName,
          Key: { pk: "nonexistent", sk: "profile" },
          UpdateExpression: "SET name = :name",
          ExpressionAttributeValues: { ":name": "John Doe" },
        }),
      ).rejects.toThrow("Item not found");
    });
  });

  describe("delete operations", () => {
    it("should delete existing item", async () => {
      await db.put({ TableName, Item: user1 });
      const deleteResult = await db.delete({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });
      expect(deleteResult.Attributes).toEqual(user1);

      const result = await db.get({
        TableName,
        Key: { pk: "user#1", sk: "profile" },
      });

      expect(result.Item).toBeUndefined();
    });

    it("should not throw when deleting non-existent item", async () => {
      const result = await db.delete({
        TableName,
        Key: { pk: "nonexistent", sk: "profile" },
      });

      expect(result.$metadata).toBeDefined();
    });
  });

  describe("batch operations", () => {
    describe("batchGet", () => {
      it("should get multiple items", async () => {
        const items = [user1, user2];

        for (const item of items) {
          await db.put({ TableName, Item: item });
        }

        const result = await db.batchGet({
          RequestItems: {
            [TableName]: {
              Keys: [
                { pk: "user#1", sk: "profile" },
                { pk: "user#2", sk: "profile" },
              ],
            },
          },
        });

        expect(result.Responses![TableName]).toHaveLength(2);
      });
    });

    describe("batchWrite", () => {
      it("should handle both puts and deletes", async () => {
        await db.batchWrite({
          RequestItems: {
            [TableName]: [
              {
                PutRequest: {
                  Item: user1,
                },
              },
              {
                PutRequest: {
                  Item: user2,
                },
              },
            ],
          },
        });

        // Verify items were written
        let result = await db.batchGet({
          RequestItems: {
            [TableName]: {
              Keys: [
                { pk: "user#1", sk: "profile" },
                { pk: "user#2", sk: "profile" },
              ],
            },
          },
        });

        expect(result.Responses![TableName]).toHaveLength(2);

        // Now delete one item
        await db.batchWrite({
          RequestItems: {
            [TableName]: [
              {
                DeleteRequest: {
                  Key: { pk: "user#1", sk: "profile" },
                },
              },
            ],
          },
        });

        result = await db.batchGet({
          RequestItems: {
            [TableName]: {
              Keys: [
                { pk: "user#1", sk: "profile" },
                { pk: "user#2", sk: "profile" },
              ],
            },
          },
        });

        expect(result.Responses![TableName]).toHaveLength(1);
      });
    });
  });
});

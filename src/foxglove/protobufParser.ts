import protobufjs from "protobufjs";
import { FileDescriptorSet } from "protobufjs/ext/descriptor";

import { MessageDefinition } from "@foxglove/message-definition";

/** A map of schema name to the schema message definition */
export type MessageDefinitionMap = Map<string, MessageDefinition>;

type Channel = {
  messageEncoding: string;
  schema: { name: string; encoding: string; data: Uint8Array } | undefined;
};

export type ParsedChannel = {
  deserialize: (data: ArrayBufferView) => unknown;
  datatypes: MessageDefinitionMap;
};

const fixTimeType = (
  type: protobufjs.ReflectionObject | null /* eslint-disable-line no-restricted-syntax */
) => {
  if (!type || !(type instanceof protobufjs.Type)) {
    return;
  }
  type.setup(); // ensure the original optimized toObject has been created
  const prevToObject = type.toObject; // eslint-disable-line @typescript-eslint/unbound-method
  const newToObject: typeof prevToObject = (message, options) => {
    const result = prevToObject.call(type, message, options);
    const { seconds, nanos } = result as { seconds: bigint; nanos: number };
    if (typeof seconds !== "bigint" || typeof nanos !== "number") {
      return result;
    }
    if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Timestamps with seconds greater than 2^53-1 are not supported (found seconds=${seconds}, nanos=${nanos})`
      );
    }
    return { sec: Number(seconds), nsec: nanos };
  };
  type.toObject = newToObject;
};

export const parseChannel = ({ schema }: Channel):ParsedChannel | null => {
  if (!schema) return null;

  const { name: schemaName, data: schemaData } = schema;
  const descriptorSet = FileDescriptorSet.decode(schemaData);

  const root = protobufjs.Root.fromDescriptor(descriptorSet);
  root.resolveAll();
  const rootType = root.lookupType(schemaName);

  fixTimeType(root.lookup(".google.protobuf.Timestamp"));
  fixTimeType(root.lookup(".google.protobuf.Duration"));

  const deserialize = (data: ArrayBufferView) => {
    return rootType.toObject(
      rootType.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      ),
      { defaults: true }
    );
  };

  const datatypes = new Map();
  protobufDefinitionsToDatatypes(datatypes, rootType);

  if (!datatypes.has(schemaName)) {
    throw new Error(
      `Protobuf schema does not contain an entry for '${schemaName}'. The schema name should be fully-qualified, e.g.`
    );
  }

  return { deserialize, datatypes };
};

const protobufScalarToRosPrimitive = (type: string): string => {
  switch (type) {
    case "double":
      return "float64";
    case "float":
      return "float32";
    case "int32":
    case "sint32":
    case "sfixed32":
      return "int32";
    case "uint32":
    case "fixed32":
      return "uint32";
    case "int64":
    case "sint64":
    case "sfixed64":
      return "int64";
    case "uint64":
    case "fixed64":
      return "uint64";
    case "bool":
      return "bool";
    case "string":
      return "string";
  }
  throw new Error(`Expected protobuf scalar type, got ${type}`);
};

const stripLeadingDot = (typeName: string): string => {
  return typeName.replace(/^\./, "");
};

export const protobufDefinitionsToDatatypes = (
  datatypes: any,
  type: any
): void => {
  const definitions: any = [];
  datatypes.set(stripLeadingDot(type.fullName), { definitions });

  for (const field of type.fieldsArray) {
    if (field.resolvedType instanceof protobufjs.Enum) {
      for (const [name, value] of Object.entries(field.resolvedType.values)) {
        definitions.push({ name, type: "int32", isConstant: true, value });
      }
      definitions.push({ type: "int32", name: field.name });
    } else if (field.resolvedType) {
      const fullName = stripLeadingDot(field.resolvedType.fullName);
      definitions.push({
        type: fullName,
        name: field.name,
        isComplex: true,
        isArray: field.repeated,
      });

      if (!datatypes.has(fullName)) {
        protobufDefinitionsToDatatypes(datatypes, field.resolvedType);
      }
    } else if (field.type === "bytes") {
      if (field.repeated) {
        throw new Error("Repeated bytes are not currently supported");
      }
      definitions.push({ type: "uint8", name: field.name, isArray: true });
    } else {
      definitions.push({
        type: protobufScalarToRosPrimitive(field.type),
        name: field.name,
        isArray: field.repeated,
      });
    }
  }
};

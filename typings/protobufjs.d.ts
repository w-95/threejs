import protobufjs from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";

declare module "protobufjs" {
  interface ReflectionObject {
    toDescriptor(
      protoVersion: string,
    ): protobufjs.Message<descriptor.IFileDescriptorSet> & descriptor.IFileDescriptorSet;
  }
  declare namespace ReflectionObject {
    // This method is added as a side effect of importing protobufjs/ext/descriptor
    export const fromDescriptor: (desc: protobufjs.Message) => protobufjs.Root;
  }
}
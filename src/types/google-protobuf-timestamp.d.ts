declare module 'google-protobuf/google/protobuf/timestamp_pb.js' {
  export class Timestamp {
    static fromDate(date: Date): Timestamp;
  }

  const timestampModule: {
    Timestamp: typeof Timestamp;
  };

  export default timestampModule;
}

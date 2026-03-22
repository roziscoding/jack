import { ServerConnector } from '../base'

export abstract class SourceServerConnector<ItemType> extends ServerConnector {
  abstract searchItems(searchTerm: string): Promise<ItemType[]>
}

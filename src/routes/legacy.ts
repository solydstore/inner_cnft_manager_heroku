/**
 * Legacy Orders Route
 *
 * Returns orders that have minted_nfts in their note_attributes.
 * Queries orders directly by name via Admin API since the Customer Account API
 * customer ID does not map to the Admin API customer ID.
 */

import { Router, Request, Response } from 'express';
import { requireApiSecret } from '../middleware/auth';
import { shopifyGraphQL } from '../services/shopify';

const router = Router();
router.use(requireApiSecret);

const ORDERS_BY_NAMES_QUERY = `
  query LegacyOrdersByName($query: String!) {
    orders(first: 50, query: $query) {
      nodes {
        id
        name
        createdAt
        customAttributes {
          key
          value
        }
        lineItems(first: 50) {
          nodes {
            id
            name
            sku
            variantTitle
            quantity
            image {
              url
              altText
            }
          }
        }
      }
    }
  }
`;

interface NoteAttribute {
  key: string;
  value: string;
}

interface AdminOrderNode {
  id: string;
  name: string;
  createdAt: string;
  customAttributes: NoteAttribute[];
  lineItems: {
    nodes: Array<{
      id: string;
      name: string;
      sku: string | null;
      variantTitle: string | null;
      quantity: number;
      image: { url: string; altText: string | null } | null;
    }>;
  };
}

router.post('/orders', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNames } = req.body;

    if (!orderNames || !Array.isArray(orderNames) || orderNames.length === 0) {
      res.status(400).json({ success: false, error: 'Missing or empty orderNames array' });
      return;
    }

    const names = orderNames.slice(0, 50) as string[];

    // Shopify search: strip # and use order name without it.
    // Search syntax: name:4583 OR name:4582
    const searchQuery = names.map((n) => `name:${n.replace(/^#/, '')}`).join(' OR ');
    console.log('[Legacy] Searching orders with query:', searchQuery);

    const result = await shopifyGraphQL<{
      data?: {
        orders?: {
          nodes: AdminOrderNode[];
        };
      };
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
    }>(ORDERS_BY_NAMES_QUERY, { query: searchQuery });

    // Log everything for diagnosis
    console.log('[Legacy] Full GraphQL response:', JSON.stringify(result, null, 2));

    if (result.errors?.length) {
      console.error('[Legacy] GraphQL errors:', JSON.stringify(result.errors, null, 2));
      res.status(400).json({ success: false, error: result.errors[0].message });
      return;
    }

    const allOrders = result.data?.orders?.nodes || [];
    console.log('[Legacy] Found', allOrders.length, 'orders from Admin API');

    // Filter to only orders with minted_nfts in customAttributes
    const legacyOrders = allOrders
      .filter((order) => {
        const mintedAttr = order.customAttributes.find((a) => a.key === 'minted_nfts');
        if (!mintedAttr?.value) return false;
        try {
          const ids = JSON.parse(mintedAttr.value);
          return Array.isArray(ids) && ids.length > 0;
        } catch {
          return false;
        }
      })
      .map((order) => {
        const mintedAttr = order.customAttributes.find((a) => a.key === 'minted_nfts')!;
        const walletAttr = order.customAttributes.find((a) => a.key === 'customer_wallet');

        return {
          orderId: order.id,
          orderName: order.name,
          orderDate: order.createdAt,
          customerWallet: walletAttr?.value || null,
          assetIds: JSON.parse(mintedAttr.value) as string[],
          lineItems: order.lineItems.nodes.map((li) => ({
            id: li.id,
            name: li.name,
            sku: li.sku,
            variantTitle: li.variantTitle,
            image: li.image,
          })),
        };
      });

    console.log('[Legacy] Returning', legacyOrders.length, 'legacy orders with minted NFTs');

    res.json({
      success: true,
      orders: legacyOrders,
      total: legacyOrders.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Legacy] Error:', message);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
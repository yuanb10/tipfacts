export const SERVICE_TYPE_LABELS: Record<string, string> = {
  counter: 'Counter service',
  table: 'Table service',
  takeout: 'Takeout / pickup',
  nonfood: 'Non-food retail',
};

export const TIP_BASE_LABELS: Record<string, string> = {
  'pre-tax': 'Pre-tax subtotal',
  'post-tax': 'Post-tax total',
  'not-sure': 'Not sure',
};

export const SCREEN_LABELS: Record<string, string> = {
  'staff-held': 'Staff held the screen',
  'handed-over': 'Screen handed over / left on counter',
  'no-screen': 'No tip screen',
  'not-sure': 'Not sure',
};

export const FEE_LABELS: Record<string, string> = {
  'service-charge': 'Service charge',
  'card-surcharge': 'Credit-card surcharge',
  none: 'None',
  other: 'Other',
};

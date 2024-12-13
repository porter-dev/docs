# Custom Metrics and Autoscaling in Porter

Porter now supports collecting custom metrics from your applications and using them for autoscaling. This guide explains how to configure these features.

## Configuring Metrics Scraping

> **Note**: Metrics scraping is only available for web services.

You can now configure Porter to scrape metrics from your application's `/metrics` endpoint. This is useful for:
- Collecting application-specific metrics
- Setting up custom autoscaling based on your metrics
- Monitoring application performance

### How to Enable Metrics Scraping


![Metrics Scraping Configuration](./images/observability/metrics-scraping-config.png)
*Metrics scraping configuration in the Advanced tab of a web service*

1. Navigate to your application dashboard
2. Select your web service
3. Go to the "Advanced" tab under service settings
4. Find the "Metrics scraping" section
5. Enable "Enable metrics scraping"
6. Configure the following options:
   - **Port**: The port where your metrics endpoint is exposed (defaults to your web service's default port)
   - **Path**: The path where metrics are exposed (defaults to `/metrics`)

Note: Our telemetry collector will automatically send requests to the specified port and path to collect metrics from your service.


## Custom Autoscaling

With metrics scraping enabled, you can now set up autoscaling based on your custom metrics instead of just CPU and memory usage.

### How to Configure Custom Autoscaling

1. Navigate to your application's "Resources" tab
2. Enable "Autoscaling"
3. Click the customize icon to switch to custom metrics mode
4. Configure:
   - **Metric Name**: Select from your exposed metrics
   - **Query**: Write a PromQL query to evaluate your metric
   - **Threshold**: Set the threshold that triggers scaling

Example configuration:
```yaml
services:
  - name: web
    autoscaling:
      enabled: true
      kind: custom
      minInstances: 1
      maxInstances: 10
      custom:
        prometheus:
          metricName: http_requests_total
          query: "avg(http_requests_total)"
          threshold: 100
```

### Switching Between Autoscaling Modes

You can switch between:
- **Default Mode**: Autoscale based on CPU/Memory usage
- **Custom Mode**: Autoscale based on your application metrics

Click the customize/restore icons to switch between modes.

## Requirements

- Your application must expose metrics in Prometheus format
- Custom autoscaling requires metrics scraping to be enabled
- Your project must have custom autoscaling enabled (contact Porter support if needed)

## Best Practices

1. **Metric Selection**: Choose metrics that accurately reflect your application's load
2. **Testing**: Test your autoscaling configuration with realistic load patterns
3. **Monitoring**: Monitor your application's scaling behavior after enabling custom autoscaling

## Learn More

- [Porter Autoscaling Documentation](https://docs.porter.run/configure/autoscaling)
- [Prometheus Query Basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Zero Downtime Deployments](https://docs.porter.run/configure/zero-downtime-deployments#graceful-shutdown)

For additional support, contact us at support@porter.run
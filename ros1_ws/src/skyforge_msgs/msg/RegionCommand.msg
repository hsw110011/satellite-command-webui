# Geographic region command published by the SkyForge ROS1 Gateway.
# Point32.x is longitude, Point32.y is latitude, Point32.z is reserved.

uint8 GPS_FLAG=0
uint8 DR_FLAG=1
uint8 MATCH_FLAG=2

std_msgs/Header header
uint8 flag
string region_id
string region_name
string shape
geometry_msgs/Point32[] points
